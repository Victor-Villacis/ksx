using System.Text.Json;

namespace Ksx.HidMaestroFakeHost;

internal sealed record FakeHostSummary(
    int SchemaVersion,
    string Command,
    string ExitReason,
    bool Handshaken,
    int IssuedCount,
    int LiveAtCleanup,
    IReadOnlyList<uint> Neutralized,
    IReadOnlyList<uint> Destroyed,
    ulong PumpPublications,
    ulong FeedbackDropped)
{
    internal const int CurrentSchemaVersion = 1;
    internal const string CommandName = "fake-host-summary";
    internal const int MaximumJsonCharacters = 2_048;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    internal static FakeHostSummary FromSession(string exitReason, FakeHostSession session) =>
        new(
            CurrentSchemaVersion,
            CommandName,
            exitReason,
            session.Handshaken,
            session.IssuedCount,
            session.LiveAtCleanup,
            session.Sink.NeutralizedControllers.ToArray(),
            session.Sink.DestroyedControllers.ToArray(),
            session.Sink.PumpPublications,
            session.Feedback.Dropped);

    internal static FakeHostSummary StartupFailure(string exitReason) =>
        new(
            CurrentSchemaVersion,
            CommandName,
            exitReason,
            Handshaken: false,
            IssuedCount: 0,
            LiveAtCleanup: 0,
            Neutralized: Array.Empty<uint>(),
            Destroyed: Array.Empty<uint>(),
            PumpPublications: 0,
            FeedbackDropped: 0);

    internal string ToBoundedJson()
    {
        string json = JsonSerializer.Serialize(this, JsonOptions);
        if (json.Length > MaximumJsonCharacters || json.Contains('\n') || json.Contains('\r'))
            throw new InvalidOperationException("The fake-host summary exceeded its one-line bound.");
        return json;
    }
}
