namespace Ksx.HidMaestroProbe;

internal sealed record SdkLock(
    int SchemaVersion,
    string Repository,
    string Tag,
    string Commit,
    ReleaseAssetLock ReleaseAsset,
    CoreDllLock CoreDll);

internal sealed record ReleaseAssetLock(string FileName, string Url, string Sha256);

internal sealed record CoreDllLock(
    string FileName,
    string Sha256,
    string FileVersion,
    string InformationalVersion);

internal sealed record PinReport(
    bool Ok,
    string Path,
    string ExpectedSha256,
    string? ActualSha256,
    string? ExpectedFileVersion,
    string? ActualFileVersion,
    string? ExpectedInformationalVersion,
    string? ActualInformationalVersion,
    IReadOnlyList<string> Mismatches);

internal sealed record ApiCheck(string Member, bool Present, string ExpectedShape);

internal sealed record ApiReport(bool Ok, IReadOnlyList<ApiCheck> Checks);

internal sealed record CatalogProfile(
    string Id,
    string Name,
    string Vendor,
    string VendorId,
    string ProductId,
    string ProductString,
    string ManufacturerString,
    string Type,
    string Connection,
    string Backend,
    string? DriverMode,
    string? TriggerMode,
    bool IsDeployable,
    int InputReportSize,
    int DescriptorByteLength,
    string? DescriptorSha256,
    string ResourceSha256);

internal sealed record CatalogReport(
    int ResourceCount,
    int DeployableCount,
    string CatalogSha256,
    IReadOnlyList<CatalogProfile> Profiles);

internal sealed record PersonaShape(
    string Name,
    string Vendor,
    string VendorId,
    string ProductId,
    string ProductString,
    string Type,
    string Connection,
    string Backend,
    string? DriverMode,
    string? TriggerMode,
    bool IsDeployable,
    int InputReportSize);

internal sealed record PersonaVerification(
    string Id,
    bool Present,
    bool Passed,
    PersonaShape Expected,
    PersonaShape? Actual,
    IReadOnlyList<string> Mismatches);

internal sealed record ContractReport(bool Ok, IReadOnlyList<PersonaVerification> Personas);

internal sealed record SafetyReport(
    bool ReadOnly,
    bool ConstructsSdkContext,
    bool CallsDriverLifecycleApis,
    string LiveExerciseStatus,
    string Reason);

internal sealed record ErrorInfo(string Code, string Message, string? ExceptionType = null);

internal sealed record InventoryDocument(
    int SchemaVersion,
    string Command,
    bool Ok,
    SdkLock SdkLock,
    PinReport SdkPin,
    ApiReport Api,
    CatalogReport? Catalog,
    ContractReport? KsxPersonaContract,
    SafetyReport Safety,
    ErrorInfo? Error);

internal sealed record TestResult(string Name, bool Passed, string Detail);

internal sealed record SelfTestDocument(
    int SchemaVersion,
    string Command,
    bool Ok,
    IReadOnlyList<TestResult> Tests);
