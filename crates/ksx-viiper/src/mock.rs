//! An in-process fake VIIPER server.
//!
//! Speaks the management protocol and the device streams well enough that
//! every caller of this crate — and later the output adapter and the
//! supervisor — is testable with no driver, no network and no GPL binary. It
//! reproduces the measured behaviours that shape client code
//! (`docs/research/viiper-2026.md` §2):
//!
//! - one JSON line per management reply, then close; RFC 7807 problems;
//! - device ids reused after removal;
//! - the device-handler reaper: a device with no stream is removed after
//!   [`MockOptions::reaper`];
//! - an inline 404 on the stream for an unknown device;
//! - the 409 auto-attach failure that leaves an orphan
//!   ([`MockOptions::fail_attach`]);
//! - plus two misbehaviours no real server shows, for the client's own
//!   guards: never replying ([`MockOptions::hang_replies`]) and an oversized
//!   reply ([`MockOptions::oversize_replies`]).
//!
//! Always compiled (not `cfg(test)`) so downstream crates can use it in their
//! tests, like `ksx_output::MockBackend`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::wire::Problem;

/// Knobs for one mock instance.
#[derive(Clone, Debug)]
pub struct MockOptions {
    /// Device-handler timeout: a device without a stream is removed this long
    /// after `add` or after its stream drops. The real default is 5 s; tests
    /// use tens of milliseconds.
    pub reaper: Duration,
    /// Answer every `add` with 409 "Failed to auto-attach device" while still
    /// creating the device (the measured orphan behaviour).
    pub fail_attach: bool,
    /// Accept management connections and never reply.
    pub hang_replies: bool,
    /// Pad every management reply past the client's cap.
    pub oversize_replies: bool,
    /// Delay the inline 404 a stream to an unknown device receives, to
    /// exercise a refusal that lands after the client's refusal window.
    pub refusal_delay: Duration,
    /// What `ping` reports.
    pub server_name: String,
    pub version: String,
}

impl Default for MockOptions {
    fn default() -> Self {
        Self {
            reaper: Duration::from_secs(5),
            fail_attach: false,
            hang_replies: false,
            oversize_replies: false,
            refusal_delay: Duration::ZERO,
            server_name: crate::SERVER_NAME.to_owned(),
            version: crate::PINNED_SERVER_VERSION.to_owned(),
        }
    }
}

#[derive(Debug)]
struct MockDevice {
    kind: String,
    vid: String,
    pid: String,
    device_specific: serde_json::Map<String, serde_json::Value>,
    /// Bytes received on the device stream, in order.
    received: Vec<u8>,
    /// Feedback queued for the stream to push.
    feedback: Vec<Vec<u8>>,
    /// Whether a stream is currently attached.
    streaming: bool,
    /// When the reaper may remove the device (None while streaming).
    reap_at: Option<Instant>,
}

#[derive(Debug, Default)]
struct MockBus {
    devices: BTreeMap<u32, MockDevice>,
}

#[derive(Debug, Default)]
struct State {
    buses: BTreeMap<u32, MockBus>,
    /// Every stream connection ever accepted, `(bus, dev)`.
    stream_log: Vec<(u32, u32)>,
    /// Management paths seen, in order.
    request_log: Vec<String>,
}

/// A running mock. Dropping it stops the listener.
pub struct MockServer {
    addr: SocketAddr,
    state: Arc<Mutex<State>>,
    options: MockOptions,
    stop: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
    reaper_thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for MockServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockServer")
            .field("addr", &self.addr)
            .finish()
    }
}

impl MockServer {
    /// Starts a mock on a free loopback port.
    pub fn spawn(options: MockOptions) -> std::io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        let addr = listener.local_addr()?;
        // Poll accept so `stop` is observed promptly.
        listener.set_nonblocking(true)?;
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));

        let accept_thread = std::thread::Builder::new()
            .name(format!("viiper-mock {addr}"))
            .spawn({
                let state = Arc::clone(&state);
                let stop = Arc::clone(&stop);
                let options = options.clone();
                move || accept_loop(listener, state, options, stop)
            })?;
        let reaper_thread = std::thread::Builder::new()
            .name(format!("viiper-mock-reaper {addr}"))
            .spawn({
                let state = Arc::clone(&state);
                let stop = Arc::clone(&stop);
                move || reaper_loop(state, stop)
            })?;

        Ok(Self {
            addr,
            state,
            options,
            stop,
            accept_thread: Some(accept_thread),
            reaper_thread: Some(reaper_thread),
        })
    }

    /// The API address to hand a [`crate::ViiperClient`].
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn options(&self) -> &MockOptions {
        &self.options
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Bus ids currently alive.
    pub fn buses(&self) -> Vec<u32> {
        self.lock().buses.keys().copied().collect()
    }

    /// `(dev id, type)` for every device on `bus`.
    pub fn devices(&self, bus: u32) -> Vec<(u32, String)> {
        self.lock()
            .buses
            .get(&bus)
            .map(|b| {
                b.devices
                    .iter()
                    .map(|(id, d)| (*id, d.kind.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether a stream is attached to `(bus, dev)` right now.
    pub fn is_streaming(&self, bus: u32, dev: u32) -> bool {
        self.lock()
            .buses
            .get(&bus)
            .and_then(|b| b.devices.get(&dev))
            .is_some_and(|d| d.streaming)
    }

    /// Every byte the mock received on `(bus, dev)`'s stream so far.
    pub fn received(&self, bus: u32, dev: u32) -> Vec<u8> {
        self.lock()
            .buses
            .get(&bus)
            .and_then(|b| b.devices.get(&dev))
            .map(|d| d.received.clone())
            .unwrap_or_default()
    }

    /// Queues feedback bytes to be pushed on `(bus, dev)`'s stream.
    pub fn push_feedback(&self, bus: u32, dev: u32, packet: &[u8]) -> bool {
        let mut state = self.lock();
        match state
            .buses
            .get_mut(&bus)
            .and_then(|b| b.devices.get_mut(&dev))
        {
            Some(device) => {
                device.feedback.push(packet.to_vec());
                true
            }
            None => false,
        }
    }

    /// Management paths seen so far.
    pub fn request_log(&self) -> Vec<String> {
        self.lock().request_log.clone()
    }

    /// `(bus, dev)` of every stream connection accepted so far.
    pub fn stream_log(&self) -> Vec<(u32, u32)> {
        self.lock().stream_log.clone()
    }

    /// Stops the listener and joins its threads.
    pub fn shutdown(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.reaper_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn accept_loop(
    listener: TcpListener,
    state: Arc<Mutex<State>>,
    options: MockOptions,
    stop: Arc<AtomicBool>,
) {
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let state = Arc::clone(&state);
                let options = options.clone();
                let stop = Arc::clone(&stop);
                if let Ok(handle) = std::thread::Builder::new()
                    .spawn(move || serve_connection(stream, state, options, stop))
                {
                    workers.push(handle);
                }
                workers.retain(|w| !w.is_finished());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
}

fn reaper_loop(state: Arc<Mutex<State>>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        {
            let now = Instant::now();
            let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
            for bus in state.buses.values_mut() {
                bus.devices
                    .retain(|_, device| !matches!(device.reap_at, Some(at) if at <= now && !device.streaming));
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return None,
            Ok(_) => {
                if byte[0] == 0 {
                    return String::from_utf8(buf).ok();
                }
                buf.push(byte[0]);
                if buf.len() > 64 * 1024 {
                    return None;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
}

fn reply(stream: &mut TcpStream, body: &str, options: &MockOptions) {
    let mut bytes = body.as_bytes().to_vec();
    if options.oversize_replies {
        bytes.extend(std::iter::repeat_n(
            b' ',
            crate::ViiperClient::MAX_REPLY_BYTES + 16,
        ));
    }
    bytes.push(b'\n');
    let _ = stream.write_all(&bytes);
    let _ = stream.shutdown(Shutdown::Both);
}

fn problem(status: u16, title: &str, detail: String) -> String {
    serde_json::to_string(&Problem {
        status,
        title: title.to_owned(),
        detail,
    })
    .expect("problem serialises")
}

fn serve_connection(
    mut stream: TcpStream,
    state: Arc<Mutex<State>>,
    options: MockOptions,
    stop: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    // A client that stopped reading must never pin a worker — and through
    // `accept_loop`'s joins, `MockServer::drop`.
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    let (path, payload) = match request.split_once(' ') {
        Some((p, rest)) => (p.to_owned(), Some(rest.trim().to_owned())),
        None => (request.clone(), None),
    };
    state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .request_log
        .push(path.clone());

    // Device stream: `bus/{b}/{d}` where d is numeric and not a verb.
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() == 3 && segments[0] == "bus" {
        if let (Ok(bus), Ok(dev)) = (segments[1].parse::<u32>(), segments[2].parse::<u32>()) {
            serve_stream(stream, state, options, stop, bus, dev);
            return;
        }
    }

    if options.hang_replies {
        // Hold the socket open until the client gives up or the mock stops.
        while !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }

    let body = handle_management(&state, &options, &path, payload.as_deref());
    reply(&mut stream, &body, &options);
}

fn handle_management(
    state: &Arc<Mutex<State>>,
    options: &MockOptions,
    path: &str,
    payload: Option<&str>,
) -> String {
    let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
    let segments: Vec<&str> = path.split('/').collect();
    match segments.as_slice() {
        ["ping"] => serde_json::json!({"server": options.server_name, "version": options.version})
            .to_string(),
        ["bus", "list"] => {
            serde_json::json!({"buses": state.buses.keys().collect::<Vec<_>>()}).to_string()
        }
        ["bus", "create"] => {
            let requested = match payload {
                Some(p) => match p.parse::<u32>() {
                    Ok(id) => Some(id),
                    Err(_) => return problem(400, "Bad Request", "invalid bus id".into()),
                },
                None => None,
            };
            let id = match requested {
                Some(id) => {
                    if state.buses.contains_key(&id) {
                        return problem(409, "Conflict", format!("bus {id} already exists"));
                    }
                    id
                }
                None => (1..).find(|id| !state.buses.contains_key(id)).unwrap_or(1),
            };
            state.buses.insert(id, MockBus::default());
            serde_json::json!({"busId": id}).to_string()
        }
        ["bus", "remove"] => {
            let Some(id) = payload.and_then(|p| p.parse::<u32>().ok()) else {
                return problem(400, "Bad Request", "missing payload".into());
            };
            if state.buses.remove(&id).is_none() {
                return problem(404, "Not Found", format!("bus {id} not found"));
            }
            serde_json::json!({"busId": id}).to_string()
        }
        ["bus", bus, "list"] => {
            let Ok(bus_id) = bus.parse::<u32>() else {
                return problem(400, "Bad Request", "invalid bus id".into());
            };
            let Some(bus) = state.buses.get(&bus_id) else {
                return problem(404, "Not Found", format!("bus {bus_id} not found"));
            };
            let devices: Vec<_> = bus
                .devices
                .iter()
                .map(|(dev, d)| device_json(bus_id, *dev, d))
                .collect();
            serde_json::json!({"devices": devices}).to_string()
        }
        ["bus", bus, "add"] => {
            let Ok(bus_id) = bus.parse::<u32>() else {
                return problem(400, "Bad Request", "invalid bus id".into());
            };
            let Some(payload) = payload else {
                return problem(400, "Bad Request", "missing payload".into());
            };
            let request: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => return problem(400, "Bad Request", format!("invalid JSON: {e}")),
            };
            let Some(kind) = request
                .get("type")
                .and_then(|t| t.as_str())
                .map(str::to_owned)
            else {
                return problem(400, "Bad Request", "missing device type".into());
            };
            let (vid, pid, specific) = match kind.as_str() {
                "xbox360" => ("0x045e", "0x028e", serde_json::json!({"subType": 1})),
                "dualshock4" => ("0x054c", "0x09cc", serde_json::json!({})),
                "dualsense" | "dualsenseedge" => ("0x054c", "0x0ce6", serde_json::json!({})),
                "ns2pro" => ("0x057e", "0x2069", serde_json::json!({})),
                "keyboard" => ("0x2e8a", "0x0010", serde_json::json!({})),
                "mouse" => ("0x2e8a", "0x0011", serde_json::json!({})),
                other => {
                    return problem(400, "Bad Request", format!("unknown device type {other}"))
                }
            };
            let reap_at = Some(Instant::now() + options.reaper);
            let Some(bus) = state.buses.get_mut(&bus_id) else {
                return problem(404, "Not Found", format!("bus {bus_id} not found"));
            };
            // Ids are reused: the lowest free id, exactly like the real server
            // handed "1" back after "1" was reaped.
            let dev_id = (1..).find(|id| !bus.devices.contains_key(id)).unwrap_or(1);
            let device = MockDevice {
                kind: kind.clone(),
                vid: vid.to_owned(),
                pid: pid.to_owned(),
                device_specific: specific.as_object().cloned().unwrap_or_default(),
                received: Vec::new(),
                feedback: Vec::new(),
                streaming: false,
                reap_at,
            };
            let json = device_json(bus_id, dev_id, &device);
            bus.devices.insert(dev_id, device);
            if options.fail_attach {
                return problem(
                    409,
                    "Conflict",
                    "Failed to auto-attach device: exec: \"usbip\": executable file not found in %PATH%".into(),
                );
            }
            json.to_string()
        }
        ["bus", bus, "remove"] => {
            let Ok(bus_id) = bus.parse::<u32>() else {
                return problem(400, "Bad Request", "invalid bus id".into());
            };
            let Some(dev_id) = payload.and_then(|p| p.parse::<u32>().ok()) else {
                return problem(400, "Bad Request", "missing payload".into());
            };
            let Some(bus) = state.buses.get_mut(&bus_id) else {
                return problem(404, "Not Found", format!("bus {bus_id} not found"));
            };
            if bus.devices.remove(&dev_id).is_none() {
                return problem(
                    404,
                    "Not Found",
                    format!("device {dev_id} not found on bus {bus_id}"),
                );
            }
            serde_json::json!({"busId": bus_id, "devId": dev_id.to_string()}).to_string()
        }
        _ => problem(404, "Not Found", format!("unknown path {path}")),
    }
}

fn device_json(bus: u32, dev: u32, device: &MockDevice) -> serde_json::Value {
    serde_json::json!({
        "busId": bus,
        "devId": dev.to_string(),
        "vid": device.vid,
        "pid": device.pid,
        "type": device.kind,
        "deviceSpecific": device.device_specific,
    })
}

fn serve_stream(
    mut stream: TcpStream,
    state: Arc<Mutex<State>>,
    options: MockOptions,
    stop: Arc<AtomicBool>,
    bus: u32,
    dev: u32,
) {
    {
        let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
        guard.stream_log.push((bus, dev));
        let Some(device) = guard
            .buses
            .get_mut(&bus)
            .and_then(|b| b.devices.get_mut(&dev))
        else {
            drop(guard);
            // Measured: one problem line on the stream, then a reset.
            if !options.refusal_delay.is_zero() {
                std::thread::sleep(options.refusal_delay);
            }
            let body = problem(
                404,
                "Not Found",
                format!("device {dev} not found on bus {bus}"),
            );
            reply(&mut stream, &body, &options);
            return;
        };
        device.streaming = true;
        device.reap_at = None;
    }

    let _ = stream.set_read_timeout(Some(Duration::from_millis(10)));
    let mut buf = [0_u8; 256];
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        // Push queued feedback.
        let pending: Vec<Vec<u8>> = {
            let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
            match guard
                .buses
                .get_mut(&bus)
                .and_then(|b| b.devices.get_mut(&dev))
            {
                Some(device) => std::mem::take(&mut device.feedback),
                // Removed out from under the stream (bus/remove): end it.
                None => break,
            }
        };
        let mut write_failed = false;
        for packet in pending {
            if stream.write_all(&packet).is_err() {
                write_failed = true;
                break;
            }
        }
        if write_failed {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(read) => {
                let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(device) = guard
                    .buses
                    .get_mut(&bus)
                    .and_then(|b| b.devices.get_mut(&dev))
                {
                    device.received.extend_from_slice(&buf[..read]);
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => break,
        }
    }

    let _ = stream.shutdown(Shutdown::Both);
    let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(device) = guard
        .buses
        .get_mut(&bus)
        .and_then(|b| b.devices.get_mut(&dev))
    {
        device.streaming = false;
        device.reap_at = Some(Instant::now() + options.reaper);
    }
}
