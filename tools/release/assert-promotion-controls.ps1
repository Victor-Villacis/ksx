[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,

    [Parameter(Mandatory = $true)]
    [string]$ApprovalConfigured,

    [switch]$RequireNoRulesetBypassActors,

    # Activate only after this workflow revision is present on the default
    # branch; requiring a check before GitHub can emit it strands every PR.
    [switch]$RequireStudioPipelineChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ApprovalConfigured -cne "true") {
    throw "KSX_PRODUCTION_APPROVAL_CONFIGURED is not true."
}
if ($Repository -notmatch '^[^/]+/[^/]+$') {
    throw "Repository must be an owner/name pair, not '$Repository'."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI is required to inspect the promotion controls."
}

function Get-GhJson {
    param(
        [Parameter(Mandatory = $true)][string]$Endpoint,
        [string]$ApiVersion = ""
    )

    $Arguments = @("api")
    if ($ApiVersion) {
        $Arguments += @("-H", "X-GitHub-Api-Version: $ApiVersion")
    }
    $Arguments += $Endpoint
    $Raw = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub control endpoint '$Endpoint' could not be inspected."
    }
    try {
        return $Raw | ConvertFrom-Json
    } catch {
        throw "GitHub control endpoint '$Endpoint' did not return valid JSON. $($_.Exception.Message)"
    }
}

$Environment = Get-GhJson "repos/$Repository/environments/production"
$ReviewRules = @($Environment.protection_rules | Where-Object type -eq 'required_reviewers')
$Reviewers = @($ReviewRules | ForEach-Object { @($_.reviewers) })
$HasBypassField = $Environment.PSObject.Properties.Name -contains 'can_admins_bypass'
if ($ReviewRules.Count -ne 1 -or $Reviewers.Count -lt 1 -or
    -not $HasBypassField -or [bool]$Environment.can_admins_bypass) {
    throw "production must have a required reviewer and explicitly forbid administrator bypass."
}
if (-not [bool]$Environment.deployment_branch_policy.custom_branch_policies -or
    [bool]$Environment.deployment_branch_policy.protected_branches) {
    throw "production must use its explicit v* deployment policy."
}
$Policies = Get-GhJson "repos/$Repository/environments/production/deployment-branch-policies"
$PolicyRows = @($Policies.branch_policies)
if ($PolicyRows.Count -ne 1 -or [string]$PolicyRows[0].name -cne 'v*' -or
    [string]$PolicyRows[0].type -cne 'tag') {
    throw "production must allow exactly the v* tag deployment-ref pattern."
}
if ($RequireNoRulesetBypassActors) {
    # These repository-administration endpoints are intentionally unavailable
    # to GITHUB_TOKEN. Only the maintainer audit may certify them; workflow mode
    # later proves immutable publication through the release postcondition.
    $ApprovalVariable = Get-GhJson "repos/$Repository/actions/variables/KSX_PRODUCTION_APPROVAL_CONFIGURED"
    if ([string]$ApprovalVariable.value -cne "true") {
        throw "The repository's KSX_PRODUCTION_APPROVAL_CONFIGURED variable is absent or not exactly true."
    }
    $ImmutableReleases = Get-GhJson `
        -Endpoint "repos/$Repository/immutable-releases" `
        -ApiVersion "2026-03-10"
    if (-not [bool]$ImmutableReleases.enabled) {
        throw "repository immutable releases must be enabled before exact candidate bytes can be published."
    }
    $ActionPermissions = Get-GhJson "repos/$Repository/actions/permissions"
    if (-not [bool]$ActionPermissions.enabled -or
        -not [bool]$ActionPermissions.sha_pinning_required) {
        throw "GitHub Actions must be enabled with full-SHA pinning required."
    }
}

$RuleSummaryPayload = Get-GhJson "repos/$Repository/rulesets"
# Windows PowerShell 5.1 preserves a top-level ConvertFrom-Json array as one
# nested Object[] when it crosses a function boundary. `foreach` deliberately
# flattens that one JSON collection without flattening any objects inside it.
$RuleSummaries = @(foreach ($Summary in $RuleSummaryPayload) { $Summary })
function Get-RequiredRuleset {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $Matches = @($RuleSummaries | Where-Object {
        [string]$_.name -ceq $Name -and [string]$_.target -ceq $Target
    })
    if ($Matches.Count -ne 1 -or [string]$Matches[0].enforcement -cne 'active') {
        throw "The active $Target ruleset '$Name' is missing or ambiguous."
    }
    $Detail = Get-GhJson "repos/$Repository/rulesets/$([int64]$Matches[0].id)"
    $HasBypassActors = $Detail.PSObject.Properties.Name -contains 'bypass_actors'
    if ($HasBypassActors -and @($Detail.bypass_actors).Count -ne 0) {
        throw "Ruleset '$Name' has bypass actors; promotion controls must apply to everyone."
    }
    if ($RequireNoRulesetBypassActors -and -not $HasBypassActors) {
        throw "Ruleset '$Name' did not expose bypass_actors. Run this administrative audit with a GitHub token that has repository-ruleset write access."
    }
    if (-not $HasBypassActors) {
        Write-Host "Ruleset '$Name' hid bypass actors from this read-only token; structural controls were verified, but the administrative no-bypass audit was not."
    }
    if (($Detail.PSObject.Properties.Name -contains 'current_user_can_bypass') -and
        [string]$Detail.current_user_can_bypass -cne 'never') {
        throw "The current workflow identity can bypass ruleset '$Name'."
    }
    return $Detail
}

$Main = Get-RequiredRuleset -Name 'KSX main promotion gate' -Target 'branch'
$MainIncludes = @($Main.conditions.ref_name.include)
if ($MainIncludes.Count -ne 1 -or [string]$MainIncludes[0] -cne 'refs/heads/main' -or
    @($Main.conditions.ref_name.exclude).Count -ne 0) {
    throw "KSX main promotion gate must target only refs/heads/main."
}
$MainRuleTypes = @($Main.rules | ForEach-Object { [string]$_.type })
foreach ($RequiredType in @('deletion', 'non_fast_forward', 'pull_request', 'required_status_checks')) {
    if ($MainRuleTypes -cnotcontains $RequiredType) {
        throw "KSX main promotion gate is missing '$RequiredType'."
    }
}
$StatusRule = @($Main.rules | Where-Object type -eq 'required_status_checks')
$RequiredContexts = @(
    'test',
    'hidmaestro-contracts',
    'hidmaestro-artifact-observation',
    'release-binary / build'
)
if ($RequireStudioPipelineChecks) {
    $RequiredContexts += @('studio-browser', 'studio-environments')
}
$ActualContexts = @($StatusRule[0].parameters.required_status_checks | ForEach-Object { [string]$_.context })
foreach ($Context in $RequiredContexts) {
    if ($ActualContexts -cnotcontains $Context) {
        throw "KSX main promotion gate is missing required check '$Context'."
    }
}
if (-not [bool]$StatusRule[0].parameters.strict_required_status_checks_policy) {
    throw "KSX main promotion gate must require an up-to-date branch before merge."
}

$Tags = Get-RequiredRuleset -Name 'KSX release tag immutability' -Target 'tag'
$TagIncludes = @($Tags.conditions.ref_name.include)
if ($TagIncludes.Count -ne 1 -or [string]$TagIncludes[0] -cne 'refs/tags/v*' -or
    @($Tags.conditions.ref_name.exclude).Count -ne 0) {
    throw "KSX release tag immutability must target only refs/tags/v*."
}
$TagRuleTypes = @($Tags.rules | ForEach-Object { [string]$_.type })
foreach ($RequiredType in @('deletion', 'non_fast_forward', 'update')) {
    if ($TagRuleTypes -cnotcontains $RequiredType) {
        throw "KSX release tag immutability is missing '$RequiredType'."
    }
}

$AuditKind = if ($RequireNoRulesetBypassActors) { "including the administrative ruleset no-bypass audit" } else { "at workflow-visible scope" }
$StudioKind = if ($RequireStudioPipelineChecks) { "including Studio/browser required checks" } else { "using the pre-merge required-check set" }
$AdministrativeKind = if ($RequireNoRulesetBypassActors) {
    "including the repository approval variable, immutable releases, and Actions SHA pinning"
} else {
    "with the workflow-context approval receipt trusted and admin-only repository policy deferred to the maintainer audit"
}
Write-Host "Verified approval receipt, production reviewer/no-bypass, v* tag deployment scope, and guarded main/tag rulesets $AuditKind, $StudioKind, $AdministrativeKind."
