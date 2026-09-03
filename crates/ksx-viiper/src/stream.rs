//! One device stream: reports out, feedback in, nothing unbounded.
//!
//! The stream is what keeps a VIIPER device alive. Its rules, all measured
//! (`docs/research/viiper-2026.md` §2.2–2.4, §3):
//!
//! - The handshake is `bus/{b}/{d}\0`. A refused handshake (unknown device)
//!   is answered on the stream itself with one RFC 7807 line and a reset.
//!   Anything else the server writes is feedback — and feedback can arrive
//!   the instant the stream opens (a host pushing LED state to a keyboard, a
//!   game rumbling a pad that was reconnected inside the reaper window), so
//!   the first bytes are *classified*, never assumed: a JSON problem line is a
//!   refusal, everything else is the first feedback packet.
//! - Reports are unframed fixed-size packets (keyboard packets carry their
//!   own count). One report is written under one deadline,
//!   [`StreamOptions::write_timeout`], however many `write` calls it takes; a
//!   report that cannot be delivered in time marks the stream closed, because
//!   a real-time lane does not queue behind a wedged peer.
//! - Feedback packets are fixed-size per device kind. A bounded reader thread
//!   chunks them into a bounded queue; [`DeviceStream::poll_feedback`] never
//!   blocks, and when the consumer falls behind the **oldest** packets are
//!   evicted so the newest state (a "rumble off") is the one that survives.
//! - Dropping the stream drops the device 5 s later unless another stream is
//!   opened for the same `(bus, dev)`. Closing is bounded: the reader wakes on
//!   a short read timeout and observes the close flag.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError};

use crate::error::ViiperError;
use crate::wire::{self, Problem};

/// Tunables for one stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamOptions {
    /// Deadline for connect + handshake write.
    pub connect_deadline: Duration,
    /// How long [`DeviceStream::open`] listens for an inline refusal after
    /// the handshake before returning the open stream. A refusal that lands
    /// later is still caught — by the reader thread — and surfaces as
    /// [`ViiperError::StreamRefused`] on the next [`DeviceStream::send`].
    pub refusal_wait: Duration,
    /// Deadline for one whole report. Zero is treated as one millisecond.
    pub write_timeout: Duration,
    /// Fixed feedback packet size for the device kind (`0` = no feedback).
    pub feedback_len: usize,
    /// Feedback packets kept for the consumer; the oldest are evicted first.
    pub feedback_queue: usize,
}

impl StreamOptions {
    /// Sensible loopback defaults for a device kind with `feedback_len`.
    pub const fn for_feedback_len(feedback_len: usize) -> Self {
        Self {
            connect_deadline: Duration::from_secs(2),
            refusal_wait: Duration::from_millis(100),
            write_timeout: Duration::from_millis(250),
            feedback_len,
            feedback_queue: 64,
        }
    }
}

/// The reader thread's poll granularity: how often it re-checks the close
/// flag while no bytes arrive, and therefore the bound on
/// [`DeviceStream::close`].
const READER_POLL: Duration = Duration::from_millis(100);

/// A refusal line is a short JSON object; anything longer is not one.
const MAX_REFUSAL_LINE: usize = 4096;

fn non_zero(timeout: Duration) -> Duration {
    timeout.max(Duration::from_millis(1))
}

fn is_timeout(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

/// Shared between the owner and the reader thread.
struct Shared {
    closed: AtomicBool,
    /// Set when the server answered the handshake with a problem line —
    /// possibly after [`StreamOptions::refusal_wait`] had already passed.
    refusal: Mutex<Option<Problem>>,
    /// Feedback packets evicted because the consumer fell behind.
    dropped: AtomicUsize,
}

impl Shared {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn refusal(&self) -> Option<Problem> {
        self.refusal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn refuse(&self, problem: Problem) {
        *self
            .refusal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(problem);
        self.close();
    }
}

/// An open device stream.
pub struct DeviceStream {
    path: String,
    stream: TcpStream,
    write_timeout: Duration,
    feedback: Receiver<Vec<u8>>,
    reader: Option<JoinHandle<()>>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for DeviceStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceStream")
            .field("path", &self.path)
            .field("closed", &self.is_closed())
            .finish()
    }
}

/// What the first bytes on a stream turned out to be.
enum FirstBytes {
    /// A complete RFC 7807 line: the handshake was refused.
    Refused(Problem),
    /// Looks like the start of a JSON line but is not complete yet.
    PartialLine,
    /// Not a refusal: feedback data (or a peer that is not VIIPER, which the
    /// codec layer will reject packet by packet).
    Data,
}

fn classify_first_bytes(bytes: &[u8]) -> FirstBytes {
    if bytes.first() != Some(&b'{') {
        return FirstBytes::Data;
    }
    if !bytes.contains(&b'\n') {
        return if bytes.len() >= MAX_REFUSAL_LINE {
            FirstBytes::Data
        } else {
            FirstBytes::PartialLine
        };
    }
    match wire::parse_reply(bytes) {
        Ok(Err(problem)) => FirstBytes::Refused(problem),
        _ => FirstBytes::Data,
    }
}

impl DeviceStream {
    /// Connects, sends the handshake, listens briefly for a refusal, and
    /// starts the feedback reader.
    pub fn open(
        addr: SocketAddr,
        bus: u32,
        dev: &str,
        options: StreamOptions,
    ) -> Result<Self, ViiperError> {
        let path = wire::stream_path(bus, dev);
        let handshake = wire::encode_request(&path, None)
            .ok_or_else(|| ViiperError::InvalidRequest(format!("NUL in device id {dev:?}")))?;

        let started = Instant::now();
        let remaining = || {
            options
                .connect_deadline
                .checked_sub(started.elapsed())
                .filter(|left| !left.is_zero())
        };
        let timeout = || ViiperError::Timeout {
            path: path.clone(),
            timeout: options.connect_deadline,
        };
        let io = |source: std::io::Error| ViiperError::Io {
            path: path.clone(),
            source,
        };

        let mut stream = TcpStream::connect_timeout(&addr, remaining().ok_or_else(timeout)?)
            .map_err(|source| ViiperError::Connect { addr, source })?;
        let _ = stream.set_nodelay(true);
        stream
            .set_write_timeout(Some(remaining().ok_or_else(timeout)?))
            .map_err(io)?;
        stream.write_all(&handshake).map_err(|source| {
            if is_timeout(source.kind()) {
                timeout()
            } else {
                ViiperError::Io {
                    path: path.clone(),
                    source,
                }
            }
        })?;

        // Listen for an inline refusal. A healthy stream is usually silent,
        // but feedback may arrive at once; only a JSON problem line refuses.
        let write_timeout = non_zero(options.write_timeout);
        stream.set_write_timeout(Some(write_timeout)).map_err(io)?;
        stream
            .set_read_timeout(Some(non_zero(options.refusal_wait)))
            .map_err(io)?;
        let mut first = Vec::new();
        let grace_until = Instant::now() + non_zero(options.refusal_wait);
        loop {
            let mut chunk = [0_u8; 1024];
            match stream.read(&mut chunk) {
                Ok(0) => {
                    return Err(ViiperError::StreamClosed { path });
                }
                Ok(read) => {
                    first.extend_from_slice(&chunk[..read]);
                    match classify_first_bytes(&first) {
                        FirstBytes::Refused(problem) => {
                            return Err(ViiperError::StreamRefused { path, problem });
                        }
                        FirstBytes::PartialLine if Instant::now() < grace_until => continue,
                        FirstBytes::PartialLine | FirstBytes::Data => break,
                    }
                }
                Err(e) if is_timeout(e.kind()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(source) => {
                    return Err(ViiperError::Io { path, source });
                }
            }
        }

        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            refusal: Mutex::new(None),
            dropped: AtomicUsize::new(0),
        });
        let (tx, rx) = crossbeam_channel::bounded(options.feedback_queue.max(1));
        let reader_stream = stream.try_clone().map_err(io)?;
        let reader = std::thread::Builder::new()
            .name(format!("viiper-feedback {path}"))
            .spawn({
                let shared = Arc::clone(&shared);
                let rx = rx.clone();
                move || reader_loop(reader_stream, options.feedback_len, first, tx, rx, shared)
            })
            .map_err(|source| {
                let _ = stream.shutdown(Shutdown::Both);
                ViiperError::Io {
                    path: path.clone(),
                    source,
                }
            })?;

        Ok(Self {
            path,
            stream,
            write_timeout,
            feedback: rx,
            reader: Some(reader),
            shared,
        })
    }

    /// `bus/{b}/{d}`.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// True once the peer closed, a write failed, a late refusal arrived, or
    /// [`Self::close`] ran.
    pub fn is_closed(&self) -> bool {
        self.shared.is_closed()
    }

    /// The refusal the server sent on this stream, if it did.
    pub fn refusal(&self) -> Option<Problem> {
        self.shared.refusal()
    }

    fn closed_error(&self) -> ViiperError {
        match self.shared.refusal() {
            Some(problem) => ViiperError::StreamRefused {
                path: self.path.clone(),
                problem,
            },
            None => ViiperError::StreamClosed {
                path: self.path.clone(),
            },
        }
    }

    /// Writes one report under one deadline. Never blocks past
    /// [`StreamOptions::write_timeout`] in total, however many `write` calls
    /// the kernel needs.
    pub fn send(&mut self, report: &[u8]) -> Result<(), ViiperError> {
        if self.is_closed() {
            return Err(self.closed_error());
        }
        let started = Instant::now();
        let mut pending = report;
        while !pending.is_empty() {
            let Some(left) = self
                .write_timeout
                .checked_sub(started.elapsed())
                .filter(|left| !left.is_zero())
            else {
                self.shared.close();
                return Err(ViiperError::StreamTimeout {
                    path: self.path.clone(),
                    timeout: self.write_timeout,
                });
            };
            if self.stream.set_write_timeout(Some(left)).is_err() {
                self.shared.close();
                return Err(ViiperError::StreamClosed {
                    path: self.path.clone(),
                });
            }
            match self.stream.write(pending) {
                Ok(0) => {
                    self.shared.close();
                    return Err(ViiperError::StreamClosed {
                        path: self.path.clone(),
                    });
                }
                Ok(written) => pending = &pending[written..],
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) if is_timeout(e.kind()) => {
                    self.shared.close();
                    return Err(ViiperError::StreamTimeout {
                        path: self.path.clone(),
                        timeout: self.write_timeout,
                    });
                }
                Err(_) => {
                    self.shared.close();
                    return Err(self.closed_error());
                }
            }
        }
        Ok(())
    }

    /// Next queued feedback packet, if any. Never blocks.
    pub fn poll_feedback(&self) -> Option<Vec<u8>> {
        self.feedback.try_recv().ok()
    }

    /// Feedback packets evicted so far because the queue was full.
    pub fn dropped_feedback(&self) -> usize {
        self.shared.dropped.load(Ordering::Relaxed)
    }

    /// Shuts the socket down and joins the reader. Bounded by
    /// [`READER_POLL`] plus one in-flight read.
    ///
    /// This closes the STREAM only. The device lives on for the server's
    /// handler timeout; call [`crate::ViiperClient::device_remove`] to end it
    /// now, or open a new stream to keep it.
    pub fn close(mut self) {
        self.close_inner();
    }

    fn close_inner(&mut self) {
        self.shared.close();
        let _ = self.stream.shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            if reader.thread().id() != std::thread::current().id() {
                let _ = reader.join();
            }
        }
    }
}

impl Drop for DeviceStream {
    fn drop(&mut self) {
        self.close_inner();
    }
}

/// Reads feedback until the socket ends or the stream is closed.
///
/// `seed` is whatever [`DeviceStream::open`] already read during the refusal
/// window. The very first bytes on a stream may still be a late refusal
/// line, so until real data has been seen a leading `{` switches the reader
/// into line mode; after that every byte is fixed-size feedback. Partial
/// packets are kept across read timeouts, never discarded.
fn reader_loop(
    mut stream: TcpStream,
    feedback_len: usize,
    seed: Vec<u8>,
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
    shared: Arc<Shared>,
) {
    if stream.set_read_timeout(Some(READER_POLL)).is_err() {
        shared.close();
        return;
    }
    let mut inbox = Inbox::new(feedback_len);
    let deliver = |packet: Vec<u8>| -> bool {
        match tx.try_send(packet) {
            Ok(()) => true,
            Err(TrySendError::Full(packet)) => {
                // Evict the oldest so the newest state survives.
                let _ = rx.try_recv();
                shared.dropped.fetch_add(1, Ordering::Relaxed);
                !matches!(tx.try_send(packet), Err(TrySendError::Disconnected(_)))
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    };
    let mut chunk = [0_u8; 1024];
    let mut pending = seed;
    loop {
        if !pending.is_empty() {
            match inbox.feed(std::mem::take(&mut pending)) {
                Fed::Packets(packets) => {
                    for packet in packets {
                        if !deliver(packet) {
                            shared.close();
                            return;
                        }
                    }
                }
                Fed::Refused(problem) => {
                    shared.refuse(problem);
                    return;
                }
            }
        }
        if shared.is_closed() {
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                shared.close();
                return;
            }
            Ok(read) => pending.extend_from_slice(&chunk[..read]),
            Err(e) if is_timeout(e.kind()) || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => {
                shared.close();
                return;
            }
        }
    }
}

enum Fed {
    Packets(Vec<Vec<u8>>),
    Refused(Problem),
}

/// Reassembles fixed-size packets, with the late-refusal guard on the first
/// bytes of the stream.
struct Inbox {
    feedback_len: usize,
    /// Nothing but (possibly) a refusal line has been seen yet.
    virgin: bool,
    line: Vec<u8>,
    packet: Vec<u8>,
}

impl Inbox {
    fn new(feedback_len: usize) -> Self {
        Self {
            feedback_len,
            virgin: true,
            line: Vec::new(),
            packet: Vec::new(),
        }
    }

    fn feed(&mut self, mut bytes: Vec<u8>) -> Fed {
        if self.virgin {
            if self.line.is_empty() && bytes.first() != Some(&b'{') {
                self.virgin = false;
            } else {
                self.line.extend_from_slice(&bytes);
                match classify_first_bytes(&self.line) {
                    FirstBytes::Refused(problem) => return Fed::Refused(problem),
                    FirstBytes::PartialLine => return Fed::Packets(Vec::new()),
                    FirstBytes::Data => {
                        // Not a refusal after all: everything seen is data.
                        self.virgin = false;
                        bytes = std::mem::take(&mut self.line);
                    }
                }
            }
        }
        let mut packets = Vec::new();
        if self.feedback_len == 0 {
            // The kind sends no feedback; bytes are discarded but the read
            // keeps watching for EOF.
            return Fed::Packets(packets);
        }
        self.packet.extend_from_slice(&bytes);
        while self.packet.len() >= self.feedback_len {
            let rest = self.packet.split_off(self.feedback_len);
            packets.push(std::mem::replace(&mut self.packet, rest));
        }
        Fed::Packets(packets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_problem_line_is_a_refusal() {
        let line = b"{\"status\":404,\"title\":\"Not Found\",\"detail\":\"device 9 not found on bus 1\"}\n";
        assert!(matches!(classify_first_bytes(line), FirstBytes::Refused(p) if p.status == 404));
        assert!(matches!(
            classify_first_bytes(&line[..10]),
            FirstBytes::PartialLine
        ));
        assert!(matches!(
            classify_first_bytes(&[0x40, 0x80]),
            FirstBytes::Data
        ));
        assert!(matches!(classify_first_bytes(&[0x02]), FirstBytes::Data));
        assert!(matches!(classify_first_bytes(&[0, 0]), FirstBytes::Data));
    }

    #[test]
    fn inbox_reassembles_fixed_packets_across_reads() {
        let mut inbox = Inbox::new(2);
        assert!(matches!(inbox.feed(vec![0x40]), Fed::Packets(p) if p.is_empty()));
        assert!(
            matches!(inbox.feed(vec![0x80, 0x01]), Fed::Packets(p) if p == vec![vec![0x40, 0x80]])
        );
        assert!(
            matches!(inbox.feed(vec![0x02, 0x03, 0x04]), Fed::Packets(p) if p == vec![vec![0x01, 0x02], vec![0x03, 0x04]])
        );
    }

    #[test]
    fn inbox_catches_a_late_refusal_but_only_before_any_data() {
        let mut inbox = Inbox::new(2);
        assert!(
            matches!(inbox.feed(b"{\"status\":404,".to_vec()), Fed::Packets(p) if p.is_empty())
        );
        assert!(matches!(
            inbox.feed(b"\"title\":\"Not Found\",\"detail\":\"gone\"}\n".to_vec()),
            Fed::Refused(p) if p.status == 404
        ));

        let mut seen_data = Inbox::new(2);
        assert!(matches!(seen_data.feed(vec![0x40, 0x80]), Fed::Packets(p) if p.len() == 1));
        // `{` after real data is just a byte.
        assert!(
            matches!(seen_data.feed(b"{\"".to_vec()), Fed::Packets(p) if p == vec![b"{\"".to_vec()])
        );
    }

    #[test]
    fn inbox_treats_json_looking_data_that_never_ends_as_data() {
        let mut inbox = Inbox::new(1);
        let junk = vec![b'{'; MAX_REFUSAL_LINE];
        match inbox.feed(junk) {
            Fed::Packets(p) => assert_eq!(p.len(), MAX_REFUSAL_LINE),
            Fed::Refused(_) => panic!("junk is not a refusal"),
        }
    }
}
