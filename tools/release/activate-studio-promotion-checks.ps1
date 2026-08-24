[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repository
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Repository -notmatch '^[^/]+/[^/]+$') {
    throw "Repository must be owner/name, not '$Repository'."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI is required."
}

function Get-GhJson {
    param([Parameter(Mandatory = $true)][string]$Endpoint)
    $Raw = & gh api $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "GitHub endpoint '$Endpoint' could not be read." }
    return $Raw | ConvertFrom-Json
}

$RepositoryState = Get-GhJson "repos/$Repository"
$DefaultBranch = [string]$RepositoryState.default_branch
$EncodedBranch = [System.Uri]::EscapeDataString($DefaultBranch)
$WorkflowBlob = Get-GhJson "repos/$Repository/contents/.github/workflows/ci.yml?ref=$EncodedBranch"
try {
    $WorkflowText = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String(([string]$WorkflowBlob.content -replace '\s', ''))
    )
} catch {
    throw "The default branch CI workflow could not be decoded. $($_.Exception.Message)"
}
foreach ($Job in @("studio-browser", "studio-environments")) {
    if ($WorkflowText -notmatch "(?m)^  $([regex]::Escape($Job)):\s*$") {
        throw "Refusing to require '$Job': default branch '$DefaultBranch' cannot emit that check yet. Merge the pipeline workflow first."
    }
}

# Repository-wide SHA enforcement must follow, not precede, the workflow
# revision which pins every action. Otherwise unrelated branches based on the
# old default branch can be rejected before this rollout merges.
$WorkflowDirectoryPayload = Get-GhJson "repos/$Repository/contents/.github/workflows?ref=$EncodedBranch"
$WorkflowDirectory = @(foreach ($Item in $WorkflowDirectoryPayload) { $Item })
foreach ($WorkflowFile in @($WorkflowDirectory | Where-Object {
    [string]$_.type -ceq "file" -and [string]$_.name -match '\.ya?ml$'
})) {
    $EncodedName = [System.Uri]::EscapeDataString([string]$WorkflowFile.name)
    $WorkflowFileBlob = Get-GhJson "repos/$Repository/contents/.github/workflows/$EncodedName`?ref=$EncodedBranch"
    $WorkflowFileText = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String(([string]$WorkflowFileBlob.content -replace '\s', ''))
    )
    foreach ($Match in [regex]::Matches($WorkflowFileText, '(?m)^\s*-?\s*uses:\s*([^\s#]+)')) {
        $Reference = [string]$Match.Groups[1].Value
        if ($Reference.StartsWith("./", [System.StringComparison]::Ordinal)) { continue }
        if ($Reference -notmatch '^[^@]+@[0-9a-fA-F]{40}$') {
            throw "Refusing to enable Actions SHA enforcement: $($WorkflowFile.name) contains unpinned use '$Reference'."
        }
    }
}

$SummaryPayload = Get-GhJson "repos/$Repository/rulesets"
$Summaries = @(foreach ($Summary in $SummaryPayload) { $Summary })
$Matches = @($Summaries | Where-Object {
    [string]$_.name -ceq "KSX main promotion gate" -and
    [string]$_.target -ceq "branch" -and
    [string]$_.enforcement -ceq "active"
})
if ($Matches.Count -ne 1) {
    throw "The active KSX main promotion gate is missing or ambiguous."
}
$Detail = Get-GhJson "repos/$Repository/rulesets/$([int64]$Matches[0].id)"
if (-not ($Detail.PSObject.Properties.Name -contains "bypass_actors")) {
    throw "GitHub hid bypass actors. Run with a maintainer token that has ruleset-write visibility."
}
if (@($Detail.bypass_actors).Count -ne 0) {
    throw "Refusing to rewrite a main ruleset that has bypass actors."
}
$StatusRules = @($Detail.rules | Where-Object type -eq "required_status_checks")
if ($StatusRules.Count -ne 1) {
    throw "The main ruleset must have exactly one required-status-check rule."
}
$RequiredContexts = @(
    "test",
    "studio-browser",
    "studio-environments",
    "hidmaestro-contracts",
    "hidmaestro-artifact-observation",
    "release-binary / build"
)
$StatusRules[0].parameters.required_status_checks = @($RequiredContexts | ForEach-Object {
    [pscustomobject]@{ context = $_ }
})
$ActionsPolicy = Get-GhJson "repos/$Repository/actions/permissions"
if (-not [bool]$ActionsPolicy.enabled -or [string]$ActionsPolicy.allowed_actions -cne "all") {
    throw "Refusing to change an unexpected Actions policy; enabled/all is required."
}

if (-not $PSCmdlet.ShouldProcess(
    "$Repository promotion controls",
    "require all six default-branch CI checks and enforce full-SHA action pins"
)) {
    return
}
# Enable the policy first. If this fails, the old four-check ruleset still
# makes Release's six-check preflight fail closed. If the ruleset update then
# fails, that same preflight remains blocked while SHA enforcement is safely on.
[ordered]@{
    enabled = $true
    allowed_actions = "all"
    sha_pinning_required = $true
} | ConvertTo-Json -Compress |
    gh api --method PUT "repos/$Repository/actions/permissions" --input - | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Actions SHA-pin enforcement could not be enabled."
}

$Body = [ordered]@{
    name = [string]$Detail.name
    target = [string]$Detail.target
    enforcement = [string]$Detail.enforcement
    bypass_actors = @()
    conditions = $Detail.conditions
    rules = @($Detail.rules)
}
$Body | ConvertTo-Json -Depth 20 -Compress |
    gh api --method PUT "repos/$Repository/rulesets/$([int64]$Detail.id)" --input - | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "The main promotion ruleset update failed."
}

$ApprovalConfigured = (& gh variable get KSX_PRODUCTION_APPROVAL_CONFIGURED --repo $Repository).Trim()
if ($LASTEXITCODE -ne 0) { throw "The production approval receipt variable could not be read." }
& (Join-Path $PSScriptRoot "assert-promotion-controls.ps1") `
    -Repository $Repository `
    -ApprovalConfigured $ApprovalConfigured `
    -RequireNoRulesetBypassActors `
    -RequireStudioPipelineChecks
