using System.Text.Json;

namespace Ksx.HidMaestroProbe;

internal static class Program
{
    private static readonly SafetyReport Safety = new(
        RequestsReadOnlySdkOperations: false,
        ConstructsSdkContext: false,
        CallsDriverLifecycleApis: false,
        LiveExerciseStatus: "static-only",
        Reason: "The inventory opens the exact hash-pinned upstream DLL as inert bytes and parses it with PEReader/MetadataReader. It never asks the CLR to load, initialize, construct, or execute the target assembly and is safe to run on an administrator CI runner.");

    public static int Main(string[] args)
    {
        object document;
        int exitCode;

        try
        {
            (document, exitCode) = args switch
            {
                [] => Inventory(),
                ["inventory"] => Inventory(),
                ["protocol"] => Protocol(),
                ["simulate-protocol"] => SimulateProtocol(),
                ["distribution-candidate", string candidateRoot] => DistributionCandidate(candidateRoot),
                ["self-test"] => SelfTest(),
                ["help"] or ["--help"] or ["-h"] => Help(),
                _ => InvalidArguments(args),
            };
        }
        catch (Exception exception)
        {
            SdkLock sdkLock;
            try
            {
                sdkLock = SdkInspection.LoadLock();
            }
            catch
            {
                sdkLock = new SdkLock(
                    0,
                    "unavailable",
                    "unavailable",
                    "unavailable",
                    new ReleaseAssetLock("unavailable", "unavailable", "unavailable"),
                    new CoreDllLock("HIDMaestro.Core.dll", "unavailable", "unavailable", "unavailable"));
            }

            document = new InventoryDocument(
                1,
                "inventory",
                false,
                sdkLock,
                new PinReport(false, string.Empty, sdkLock.CoreDll.Sha256, null, null, null, null, null, ["probe.exception"]),
                new ApiReport(false, []),
                null,
                null,
                Safety,
                new ErrorInfo("probe_failed", exception.Message, exception.GetType().FullName));
            exitCode = 2;
        }

        // The probe owns stdout and writes once. Every command, including
        // errors and help, is one complete JSON document.
        Console.WriteLine(JsonSerializer.Serialize(document, JsonOptions.Output));
        return exitCode;
    }

    private static (object Document, int ExitCode) Inventory()
    {
        SdkLock sdkLock = SdkInspection.LoadLock();
        (PinReport pin, StaticSdkImage? image) = SdkInspection.InspectPinnedFile(sdkLock);
        if (!pin.Ok || image is null)
        {
            var failed = new InventoryDocument(
                1,
                "inventory",
                false,
                sdkLock,
                pin,
                new ApiReport(false, []),
                null,
                null,
                Safety,
                new ErrorInfo("sdk_pin_mismatch", "The external HIDMaestro.Core.dll did not match the pinned v1.6.1 release."));
            return (failed, 2);
        }

        ApiReport api = image.Api;
        CatalogReport catalog = image.Catalog;
        ContractReport contract = PersonaContract.Verify(catalog.Profiles);
        bool ok = pin.Ok
            && api.Ok
            && CatalogInspection.MatchesPinnedContract(catalog)
            && contract.Ok;

        var document = new InventoryDocument(
            1,
            "inventory",
            ok,
            sdkLock,
            pin,
            api,
            catalog,
            contract,
            Safety,
            ok ? null : new ErrorInfo("conformance_failed", "The pinned SDK did not satisfy the read-only KSX catalog contract."));
        return (document, ok ? 0 : 1);
    }

    private static (object Document, int ExitCode) SelfTest()
    {
        SelfTestDocument document = PureSelfTests.Run();
        return (document, document.Ok ? 0 : 1);
    }

    private static (object Document, int ExitCode) Protocol()
    {
        var document = new ProtocolDocument(1, "protocol", true, ProtocolContract.Describe(), Safety);
        return (document, 0);
    }

    private static (object Document, int ExitCode) SimulateProtocol()
    {
        SimulationDocument document = ProtocolContract.Simulate(Safety);
        return (document, document.Ok ? 0 : 1);
    }

    private static (object Document, int ExitCode) DistributionCandidate(string candidateRoot)
    {
        DistributionCandidateDocument document = DistributionAudit.Run(candidateRoot, Safety);
        return (document, document.Ok ? 0 : 1);
    }

    private static (object Document, int ExitCode) Help() =>
        (new
        {
            schemaVersion = 1,
            command = "help",
            ok = true,
            commands = new[]
            {
                new { syntax = "ksx-hidmaestro-probe", effect = "Statically read and verify the pinned SDK metadata and embedded profile catalog without loading it." },
                new { syntax = "ksx-hidmaestro-probe inventory", effect = "Same as the default command." },
                new { syntax = "ksx-hidmaestro-probe protocol", effect = "Describe the frozen, pure host-protocol simulation contract." },
                new { syntax = "ksx-hidmaestro-probe simulate-protocol", effect = "Run the deterministic cadence, feedback, and teardown transcript." },
                new { syntax = "ksx-hidmaestro-probe distribution-candidate <directory>", effect = "Statically audit a caller-supplied, manifest-pinned package candidate without loading or executing it." },
                new { syntax = "ksx-hidmaestro-probe self-test", effect = "Run pure parser and contract tests." },
            },
            safety = Safety,
        }, 0);

    private static (object Document, int ExitCode) InvalidArguments(string[] args) =>
        (new
        {
            schemaVersion = 1,
            command = "invalid",
            ok = false,
            arguments = args,
            error = new ErrorInfo("invalid_arguments", "Use no arguments, inventory, protocol, simulate-protocol, distribution-candidate <directory>, self-test, or help."),
            safety = Safety,
        }, 2);
}
