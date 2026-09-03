//! The blocking management client: one TCP connection per call, one deadline
//! per call, a byte cap on the reply.
//!
//! Modelled on `ksx-backend`'s `studio_health_at`: every socket operation is
//! bounded by what is left of a single deadline, and the caller admits only
//! addresses it trusts (a supervisor's own loopback child, or a paired remote
//! endpoint). The client holds no socket between calls, so it is `Clone` and
//! cheap to keep around.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;

use crate::devices::DeviceKind;
use crate::error::ViiperError;
use crate::wire::{
    self, BusList, BusReply, Device, DeviceCreateRequest, DeviceList, DeviceRemoved, PingReply,
    Reply,
};

/// Management client for one VIIPER API address.
#[derive(Clone, Debug)]
pub struct ViiperClient {
    addr: SocketAddr,
    deadline: Duration,
    max_reply: usize,
}

impl ViiperClient {
    /// Whole-exchange deadline for one management call. Loopback answers in
    /// single milliseconds (measured); a LAN endpoint in tens. Two seconds is
    /// "the server is wedged", not "the network is slow".
    pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(2);

    /// A management reply is a few hundred bytes. Anything past this is a peer
    /// that is not VIIPER, and the read stops rather than growing a buffer.
    pub const MAX_REPLY_BYTES: usize = 64 * 1024;

    pub fn new(addr: SocketAddr) -> Self {
        Self {
            addr,
            deadline: Self::DEFAULT_DEADLINE,
            max_reply: Self::MAX_REPLY_BYTES,
        }
    }

    /// Same address, different per-call deadline.
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn deadline(&self) -> Duration {
        self.deadline
    }

    /// `ping`.
    pub fn ping(&self) -> Result<PingReply, ViiperError> {
        self.call_json("ping", None)
    }

    /// `ping`, refusing anything that is not a VIIPER of `expected_version`.
    ///
    /// The codecs in [`crate::devices`] are transcribed from one release;
    /// a supervisor calls this once before creating anything.
    pub fn ping_pinned(&self, expected_version: &'static str) -> Result<PingReply, ViiperError> {
        let reply = self.ping()?;
        if reply.server != crate::SERVER_NAME {
            return Err(ViiperError::NotViiper {
                addr: self.addr,
                server: reply.server,
                expected: crate::SERVER_NAME,
            });
        }
        if reply.version != expected_version {
            return Err(ViiperError::VersionMismatch {
                addr: self.addr,
                found: reply.version,
                expected: expected_version,
            });
        }
        Ok(reply)
    }

    /// `bus/list`.
    pub fn bus_list(&self) -> Result<Vec<u32>, ViiperError> {
        Ok(self.call_json::<BusList>("bus/list", None)?.buses)
    }

    /// `bus/create [id]` — `requested` asks for a specific bus id.
    pub fn bus_create(&self, requested: Option<u32>) -> Result<u32, ViiperError> {
        let payload = requested.map(|id| id.to_string());
        Ok(self
            .call_json::<BusReply>("bus/create", payload.as_deref())?
            .bus_id)
    }

    /// `bus/remove <id>`. Removes every device on the bus with it.
    pub fn bus_remove(&self, bus: u32) -> Result<(), ViiperError> {
        self.call_json::<BusReply>("bus/remove", Some(&bus.to_string()))?;
        Ok(())
    }

    /// `bus/{b}/list`.
    pub fn device_list(&self, bus: u32) -> Result<Vec<Device>, ViiperError> {
        Ok(self
            .call_json::<DeviceList>(&format!("bus/{bus}/list"), None)?
            .devices)
    }

    /// `bus/{b}/add {…}`.
    ///
    /// On success the caller has the server's device-handler timeout (5 s by
    /// default) to open the device stream. A 409 with "Failed to auto-attach"
    /// means the device was created but not attached and will be reaped
    /// unless a stream is opened; see `docs/research/viiper-2026.md` §2.4.
    pub fn device_add(
        &self,
        bus: u32,
        request: &DeviceCreateRequest,
    ) -> Result<Device, ViiperError> {
        let payload = serde_json::to_string(request)
            .map_err(|e| ViiperError::InvalidRequest(e.to_string()))?;
        self.call_json(&format!("bus/{bus}/add"), Some(&payload))
    }

    /// [`ViiperClient::device_add`] for `kind` with the default identity.
    pub fn device_add_kind(&self, bus: u32, kind: DeviceKind) -> Result<Device, ViiperError> {
        self.device_add(bus, &DeviceCreateRequest::of(kind))
    }

    /// `bus/{b}/remove <dev>`.
    pub fn device_remove(&self, bus: u32, dev: &str) -> Result<(), ViiperError> {
        self.call_json::<DeviceRemoved>(&format!("bus/{bus}/remove"), Some(dev))?;
        Ok(())
    }

    /// One exchange, parsed into `T`.
    fn call_json<T: DeserializeOwned>(
        &self,
        path: &str,
        payload: Option<&str>,
    ) -> Result<T, ViiperError> {
        match self.call(path, payload)? {
            Reply::Json(value) => {
                serde_json::from_value(value.clone()).map_err(|e| ViiperError::Malformed {
                    path: path.to_owned(),
                    detail: format!("{e} in {value}"),
                })
            }
            Reply::Empty => Err(ViiperError::Malformed {
                path: path.to_owned(),
                detail: "empty reply where a body was expected".to_owned(),
            }),
        }
    }

    /// One exchange: connect, write the request, read to EOF, parse.
    pub fn call(&self, path: &str, payload: Option<&str>) -> Result<Reply, ViiperError> {
        let request = wire::encode_request(path, payload)
            .ok_or_else(|| ViiperError::InvalidRequest(format!("NUL in `{path}` or payload")))?;
        let started = Instant::now();
        let remaining = || {
            self.deadline
                .checked_sub(started.elapsed())
                .filter(|left| !left.is_zero())
        };
        let timeout = || ViiperError::Timeout {
            path: path.to_owned(),
            timeout: self.deadline,
        };
        let io = |source: std::io::Error| {
            if matches!(
                source.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                ViiperError::Timeout {
                    path: path.to_owned(),
                    timeout: self.deadline,
                }
            } else {
                ViiperError::Io {
                    path: path.to_owned(),
                    source,
                }
            }
        };

        let connect_timeout = remaining().ok_or_else(timeout)?;
        let mut stream =
            TcpStream::connect_timeout(&self.addr, connect_timeout).map_err(|source| {
                ViiperError::Connect {
                    addr: self.addr,
                    source,
                }
            })?;
        let _ = stream.set_nodelay(true);

        let mut pending = request.as_slice();
        while !pending.is_empty() {
            let left = remaining().ok_or_else(timeout)?;
            stream.set_write_timeout(Some(left)).map_err(io)?;
            match stream.write(pending) {
                Ok(0) => {
                    return Err(ViiperError::Io {
                        path: path.to_owned(),
                        source: std::io::Error::new(
                            std::io::ErrorKind::WriteZero,
                            "server accepted no bytes",
                        ),
                    })
                }
                Ok(written) => pending = &pending[written..],
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io(e)),
            }
        }
        // Half-close so a server that reads to EOF before answering (none do
        // today, but the framing allows it) is not left waiting on us.
        let _ = stream.shutdown(std::net::Shutdown::Write);

        let mut reply = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let left = remaining().ok_or_else(timeout)?;
            stream.set_read_timeout(Some(left)).map_err(io)?;
            let room = self.max_reply + 1 - reply.len();
            let want = chunk.len().min(room);
            match stream.read(&mut chunk[..want]) {
                Ok(0) => break,
                Ok(read) => {
                    reply.extend_from_slice(&chunk[..read]);
                    if reply.len() > self.max_reply {
                        return Err(ViiperError::ReplyTooLarge {
                            path: path.to_owned(),
                            max: self.max_reply,
                        });
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io(e)),
            }
        }

        match wire::parse_reply(&reply) {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(problem)) => Err(ViiperError::Refused {
                path: path.to_owned(),
                problem,
            }),
            Err(malformed) => Err(ViiperError::Malformed {
                path: path.to_owned(),
                detail: format!("{malformed}: {:?}", String::from_utf8_lossy(&reply)),
            }),
        }
    }
}
