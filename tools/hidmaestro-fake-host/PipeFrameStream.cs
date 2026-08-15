using System.Buffers.Binary;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal sealed class PipeFrameStream
{
    internal const int WriteTimeoutMilliseconds = 250;

    private readonly Stream _stream;

    internal PipeFrameStream(Stream stream)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
        if (!stream.CanRead || !stream.CanWrite)
            throw new ArgumentException("The KSXH transport must be duplex.", nameof(stream));
    }

    /// <summary>
    /// Returns null only for EOF at a frame boundary. Partial EOF and malformed
    /// frames are protocol failures and never receive a guessed Fault response.
    /// </summary>
    internal async ValueTask<HostFrame?> ReadFrameAsync(CancellationToken cancellationToken)
    {
        var header = new byte[HostProtocolCodec.HeaderBytes];
        int headerBytes = await ReadExactAsync(
            header,
            allowInitialEof: true,
            cancellationToken).ConfigureAwait(false);
        if (headerBytes == 0)
            return null;

        uint declared = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12, 4));
        if (declared > HostProtocolCodec.MaximumPayloadBytes)
            throw new InvalidDataException("The KSXH payload exceeds the V1 bound.");

        int payloadBytes = checked((int)declared);
        var encoded = new byte[HostProtocolCodec.HeaderBytes + payloadBytes];
        header.CopyTo(encoded, 0);
        if (payloadBytes != 0)
        {
            _ = await ReadExactAsync(
                encoded.AsMemory(HostProtocolCodec.HeaderBytes, payloadBytes),
                allowInitialEof: false,
                cancellationToken).ConfigureAwait(false);
        }

        if (!HostProtocolCodec.TryDecode(encoded, out HostFrame? frame, out HostProtocolError error)
            || frame is null)
        {
            throw new InvalidDataException($"The KSXH frame was refused: {error}.");
        }
        return frame;
    }

    internal Task WriteFrameAsync(HostFrame frame, CancellationToken cancellationToken) =>
        WriteEncodedAsync(frame.Encode(), cancellationToken);

    internal async Task WriteEncodedAsync(byte[] encoded, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(encoded);
        if (encoded.Length is < HostProtocolCodec.HeaderBytes or > HostProtocolCodec.MaximumFrameBytes)
            throw new ArgumentOutOfRangeException(nameof(encoded));

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(WriteTimeoutMilliseconds);
        try
        {
            await _stream.WriteAsync(encoded, timeout.Token).ConfigureAwait(false);
            await _stream.FlushAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("A KSXH write exceeded its fixed deadline.");
        }
    }

    private async ValueTask<int> ReadExactAsync(
        Memory<byte> destination,
        bool allowInitialEof,
        CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < destination.Length)
        {
            int read = await _stream.ReadAsync(destination[offset..], cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                if (allowInitialEof && offset == 0)
                    return 0;
                throw new EndOfStreamException("The KSXH pipe ended inside a frame.");
            }
            offset += read;
        }
        return offset;
    }
}
