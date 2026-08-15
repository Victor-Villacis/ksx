using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using HIDMaestro;
using HIDMaestro.Internal;

namespace Ksx.HidMaestroHost;

internal sealed class HostSharedMemoryFactory : IRuntimeOwnedSharedMemoryFactory
{
    public RuntimeOwnedSharedMemoryIO Create(RuntimeOwnedDeviceSet ownedDevice) =>
        new(ownedDevice, new HostSharedMemoryEndpoint());
}

internal sealed unsafe class HostSharedMemoryEndpoint : IRuntimeOwnedSharedMemoryEndpoint
{
    private const int InputBytes = 362;
    private const int OutputBytes = 16_904;
    private const int OutputSlotBytes = 264;
    private const int OutputSlotCount = 64;
    private const uint PageReadWrite = 0x04;
    private const uint FileMapAllAccess = 0x000F001F;
    private const uint EventAllAccess = 0x001F0003;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ErrorAlreadyExists = 183;
    private const string Sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GR;;;WD)";

    private readonly object _gate = new();
    private nint _inputMapping;
    private nint _outputMapping;
    private byte* _input;
    private byte* _output;
    private nint _inputEvent;
    private nint _outputEvent;
    private Thread? _reader;
    private CancellationTokenSource? _stop;
    private Action<HMOutputPacket>? _callback;
    private uint _lastOutputSequence;
    private Exception? _readerFailure;
    private bool _disposed;

    public void Start(Action<HMOutputPacket> outputCallback)
    {
        ArgumentNullException.ThrowIfNull(outputCallback);
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_reader is not null) throw new InvalidOperationException("The shared-memory endpoint is already started.");
            using var security = NativeSecurity.Create(Sddl);
            _inputMapping = CreateOwnedMapping("Global\\HIDMaestroInput0", InputBytes, security.Attributes);
            try
            {
                _outputMapping = CreateOwnedMapping("Global\\HIDMaestroOutput0", OutputBytes, security.Attributes);
                _input = Map(_inputMapping, InputBytes);
                _output = Map(_outputMapping, OutputBytes);
                _inputEvent = CreateOwnedEvent("Global\\HIDMaestroInputEvent0", security.Attributes);
                _outputEvent = OpenOutputEvent();
                new Span<byte>(_input, InputBytes).Clear();
                new Span<byte>(_output, OutputBytes).Clear();
                _callback = outputCallback;
                _stop = new CancellationTokenSource();
                _reader = new Thread(ReadOutput) { IsBackground = true, Name = "ksx-hidmaestro-output" };
                _reader.Start(_stop.Token);
            }
            catch
            {
                CloseNative();
                throw;
            }
        }
    }

    public void SubmitLegacyInputData(ReadOnlySpan<byte> dataWithoutReportId)
    {
        if (dataWithoutReportId.Length != 63) throw new ArgumentException("DualSense input data must be exactly 63 bytes.", nameof(dataWithoutReportId));
        lock (_gate)
        {
            ThrowIfUnavailable();
            int current = Volatile.Read(ref *(int*)_input);
            int odd = (current & ~1) + 1;
            Volatile.Write(ref *(int*)_input, odd);
            Thread.MemoryBarrier();
            *(uint*)(_input + 4) = 63;
            dataWithoutReportId.CopyTo(new Span<byte>(_input + 8, 63));
            new Span<byte>(_input + 71, 193).Clear();
            new Span<byte>(_input + 264, 14).Clear();
            *(uint*)(_input + 278) = 0;
            new Span<byte>(_input + 282, 80).Clear();
            Thread.MemoryBarrier();
            Volatile.Write(ref *(int*)_input, odd + 1);
            if (!SetEvent(_inputEvent)) throw Last("The HIDMaestro input event could not be signalled.");
        }
    }

    public void Neutralize()
    {
        Span<byte> neutral = stackalloc byte[63];
        neutral[0] = 127;
        neutral[1] = 127;
        neutral[2] = 127;
        neutral[3] = 127;
        neutral[7] = 8;
        SubmitLegacyInputData(neutral);
    }

    public void StopOutput()
    {
        Thread? reader;
        lock (_gate)
        {
            if (_reader is null) return;
            _stop!.Cancel();
            _ = SetEvent(_outputEvent);
            reader = _reader;
        }
        if (!reader.Join(TimeSpan.FromSeconds(2))) throw new TimeoutException("The HIDMaestro output reader did not stop.");
        lock (_gate)
        {
            _reader = null;
            _stop?.Dispose();
            _stop = null;
            if (_readerFailure is not null) throw new InvalidOperationException("The HIDMaestro output reader failed.", _readerFailure);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            if (_reader is not null) throw new InvalidOperationException("Output must be stopped before the shared-memory endpoint is disposed.");
            _disposed = true;
            CloseNative();
        }
    }

    private void ReadOutput(object? state)
    {
        var token = (CancellationToken)state!;
        try
        {
            while (!token.IsCancellationRequested)
            {
                uint wait = WaitForSingleObject(_outputEvent, 250);
                if (wait is not (WaitObject0 or WaitTimeout)) throw Last("The HIDMaestro output wait failed.");
                DrainOutput();
            }
        }
        catch (Exception error)
        {
            lock (_gate) _readerFailure = error;
        }
    }

    private void DrainOutput()
    {
        uint head = Volatile.Read(ref *(uint*)_output);
        uint next = _lastOutputSequence + 1;
        if (head >= OutputSlotCount && next <= head - OutputSlotCount) next = head - OutputSlotCount + 1;
        while (next <= head)
        {
            byte* slot = _output + 8 + ((next - 1) % OutputSlotCount) * OutputSlotBytes;
            uint first = Volatile.Read(ref *(uint*)slot);
            if (first != next) break;
            Thread.MemoryBarrier();
            byte source = slot[4];
            byte reportId = slot[5];
            ushort size = *(ushort*)(slot + 6);
            if (size > 256) throw new InvalidDataException("HIDMaestro produced an oversized output packet.");
            byte[] data = new ReadOnlySpan<byte>(slot + 8, size).ToArray();
            Thread.MemoryBarrier();
            uint second = Volatile.Read(ref *(uint*)slot);
            if (second != first) continue;
            if (source > (byte)HMOutputSource.HidFeatureRead) throw new InvalidDataException("HIDMaestro produced an unknown output source.");
            _callback!(new HMOutputPacket((HMOutputSource)source, reportId, data, next));
            _lastOutputSequence = next;
            next++;
        }
    }

    private void ThrowIfUnavailable()
    {
        ThrowIfDisposed();
        if (_reader is null || _input == null || _readerFailure is not null)
            throw new InvalidOperationException("The HIDMaestro shared-memory endpoint is unavailable.", _readerFailure);
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(HostSharedMemoryEndpoint));
    }

    private static nint CreateOwnedMapping(string name, int bytes, nint security)
    {
        nint handle = CreateFileMappingW(new nint(-1), security, PageReadWrite, 0, (uint)bytes, name);
        int error = Marshal.GetLastWin32Error();
        if (handle == 0) throw Last("A HIDMaestro shared-memory section could not be created.");
        if (error == ErrorAlreadyExists)
        {
            _ = CloseHandle(handle);
            throw new InvalidOperationException("A foreign HIDMaestro shared-memory section already owns controller zero.");
        }
        return handle;
    }

    private static nint CreateOwnedEvent(string name, nint security)
    {
        nint handle = CreateEventExW(security, name, 0, EventAllAccess);
        int error = Marshal.GetLastWin32Error();
        if (handle == 0) throw Last("A HIDMaestro event could not be created.");
        if (error == ErrorAlreadyExists)
        {
            _ = CloseHandle(handle);
            throw new InvalidOperationException("A foreign HIDMaestro event already owns controller zero.");
        }
        return handle;
    }

    private static nint OpenOutputEvent()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (true)
        {
            nint handle = OpenEventW(EventAllAccess, false, "Global\\HIDMaestroOutputEvent0");
            if (handle != 0) return handle;
            if (DateTime.UtcNow >= deadline)
                throw Last("The bound HIDMaestro device did not publish its output event.");
            Thread.Sleep(25);
        }
    }

    private static byte* Map(nint handle, int bytes)
    {
        nint address = MapViewOfFile(handle, FileMapAllAccess, 0, 0, (nuint)bytes);
        if (address == 0) throw Last("A HIDMaestro shared-memory section could not be mapped.");
        return (byte*)address;
    }

    private void CloseNative()
    {
        if (_input != null) { _ = UnmapViewOfFile((nint)_input); _input = null; }
        if (_output != null) { _ = UnmapViewOfFile((nint)_output); _output = null; }
        Close(ref _inputEvent); Close(ref _outputEvent); Close(ref _inputMapping); Close(ref _outputMapping);
    }

    private static void Close(ref nint handle)
    {
        if (handle == 0) return;
        _ = CloseHandle(handle);
        handle = 0;
    }

    private static Win32Exception Last(string message) => new(Marshal.GetLastWin32Error(), message);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint CreateFileMappingW(nint file, nint attributes, uint protect, uint high, uint low, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint MapViewOfFile(nint mapping, uint access, uint high, uint low, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnmapViewOfFile(nint address);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint CreateEventExW(nint attributes, string name, uint flags, uint access);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint OpenEventW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetEvent(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(nint handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}

internal sealed class NativeSecurity : IDisposable
{
    private nint _descriptor;
    private nint _attributes;
    private NativeSecurity(nint descriptor, nint attributes) { _descriptor = descriptor; _attributes = attributes; }
    internal nint Attributes => _attributes;

    internal static NativeSecurity Create(string sddl)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out nint descriptor, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        nint attributes = Marshal.AllocHGlobal(Marshal.SizeOf<SecurityAttributes>());
        Marshal.StructureToPtr(new SecurityAttributes
        {
            Length = Marshal.SizeOf<SecurityAttributes>(),
            SecurityDescriptor = descriptor,
            InheritHandle = 0,
        }, attributes, false);
        return new NativeSecurity(descriptor, attributes);
    }

    public void Dispose()
    {
        if (_attributes != 0) { Marshal.FreeHGlobal(_attributes); _attributes = 0; }
        if (_descriptor != 0) { _ = LocalFree(_descriptor); _descriptor = 0; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal int Length; internal nint SecurityDescriptor; internal int InheritHandle; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out nint descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);
}
