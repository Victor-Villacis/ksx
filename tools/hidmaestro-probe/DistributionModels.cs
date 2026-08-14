namespace Ksx.HidMaestroProbe;

internal sealed record DistributionManifest(
    int SchemaVersion,
    string CandidateState,
    string UpstreamTag,
    string UpstreamCommit,
    string DriverDate,
    string DriverVersion,
    IReadOnlyList<DistributionFilePin> Files);

internal sealed record DistributionFilePin(string Role, string Path, string Sha256);

internal sealed record DistributionCheck(string Code, bool Passed, string Detail);

internal sealed record DistributionFileReport(
    string Role,
    string Path,
    bool Present,
    string? ExpectedSha256,
    string? ActualSha256,
    string SignatureState);

internal sealed record DistributionSdkReport(
    bool ManagedPe,
    string? AssemblyVersion,
    int ProfileResourceCount,
    string? ProfileCatalogSha256,
    IReadOnlyList<string> ForbiddenResources,
    IReadOnlyList<string> UnknownResources,
    IReadOnlyList<string> ForbiddenLifecycleMembers,
    IReadOnlyList<string> MissingRuntimeMembers);

internal sealed record DistributionCandidateDocument(
    int SchemaVersion,
    string Command,
    string Assurance,
    bool Ok,
    bool DistributionReady,
    string CandidateRoot,
    string ManifestPath,
    string? CandidateState,
    IReadOnlyList<DistributionFileReport> Files,
    DistributionSdkReport? Sdk,
    IReadOnlyList<DistributionCheck> Checks,
    SafetyReport Safety,
    ErrorInfo? Error);

internal sealed record DistributionFacts(
    DistributionManifest Manifest,
    IReadOnlyDictionary<string, DistributionFileReport> Files,
    DistributionSdkReport Sdk,
    IReadOnlyList<string> UnexpectedFiles,
    IReadOnlyList<string> ReparsePoints,
    InfPackageFacts MainInf,
    InfPackageFacts XusbInf,
    bool LicenseMatches);

internal sealed record InfPackageFacts(
    string DriverDate,
    string DriverVersion,
    string CatalogFile,
    string Provider,
    string ServiceBinary,
    bool PnpLockdown);
