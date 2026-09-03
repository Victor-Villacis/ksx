//! Error taxonomy for the VIIPER client.
//!
//! Three families that must never merge, because each has a different fix:
//! the server is not there ([`ViiperError::Connect`], [`ViiperError::NotViiper`],
//! [`ViiperError::VersionMismatch`] — start or install it), the server said no
//! ([`ViiperError::Refused`], [`ViiperError::StreamRefused`] — a protocol-level
//! answer with an RFC 7807 body the caller can show verbatim), and the
//! exchange did not complete ([`ViiperError::Timeout`], [`ViiperError::Io`],
//! [`ViiperError::StreamClosed`] — retry or reconnect).

use std::net::SocketAddr;
use std::time::Duration;

use crate::wire::Problem;

/// What can go wrong talking to a VIIPER server.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ViiperError {
    /// No TCP connection could be made within the deadline.
    #[error("could not reach the VIIPER API at {addr}: {source}")]
    Connect {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },

    /// The exchange started but did not finish inside the deadline. The
    /// socket is dropped; the server may or may not have acted on the request.
    #[error("VIIPER API call `{path}` did not complete within {timeout:?}")]
    Timeout { path: String, timeout: Duration },

    /// A socket error other than a timeout.
    #[error("VIIPER API I/O error during `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// The server answered with an RFC 7807 problem. `problem.status` carries
    /// the HTTP-style code (400 bad request, 404 unknown bus/device, 409
    /// conflict such as a failed auto-attach, 500 server error).
    #[error("VIIPER refused `{path}`: {problem}")]
    Refused { path: String, problem: Problem },

    /// The reply was neither empty, nor JSON of the expected shape, nor a
    /// problem. Carries the detail so a bug report has the bytes.
    #[error("VIIPER reply to `{path}` was not understood: {detail}")]
    Malformed { path: String, detail: String },

    /// The reply exceeded the client's byte cap. A management reply is a few
    /// hundred bytes; this is a misbehaving peer, not a big answer.
    #[error("VIIPER reply to `{path}` exceeded {max} bytes")]
    ReplyTooLarge { path: String, max: usize },

    /// Something answered `ping`, but not as VIIPER.
    #[error("the endpoint at {addr} answered `ping` as {server:?}, not {expected:?}")]
    NotViiper {
        addr: SocketAddr,
        server: String,
        expected: &'static str,
    },

    /// A VIIPER answered, but not the release the codecs were written for.
    #[error("VIIPER at {addr} is version {found}; this build of ksx is pinned to {expected}")]
    VersionMismatch {
        addr: SocketAddr,
        found: String,
        expected: &'static str,
    },

    /// The device-stream handshake was answered with a problem on the stream
    /// itself (measured: an unknown device returns a 404 line, then a reset).
    #[error("device stream `{path}` was refused: {problem}")]
    StreamRefused { path: String, problem: Problem },

    /// The device stream is gone: the peer closed it, a write failed, or
    /// [`crate::DeviceStream::close`] ran. The device will be reaped by the
    /// server 5 s after the drop unless a new stream is opened.
    #[error("device stream `{path}` is closed")]
    StreamClosed { path: String },

    /// A report could not be written within the stream's write timeout. Treated
    /// like a closed stream by callers: the server is wedged or the socket is
    /// backed up, and a real-time lane does not queue behind either.
    #[error("device stream `{path}` write did not complete within {timeout:?}")]
    StreamTimeout { path: String, timeout: Duration },

    /// A request argument was unrepresentable on the wire (a NUL in a path).
    #[error("invalid VIIPER request: {0}")]
    InvalidRequest(String),
}

impl ViiperError {
    /// True when the root cause is "no VIIPER is answering here" — the family
    /// a supervisor acts on by starting or installing the server.
    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            ViiperError::Connect { .. }
                | ViiperError::NotViiper { .. }
                | ViiperError::VersionMismatch { .. }
        )
    }

    /// True when the server answered with a problem body.
    pub fn is_refused(&self) -> bool {
        matches!(
            self,
            ViiperError::Refused { .. } | ViiperError::StreamRefused { .. }
        )
    }

    /// True when the exchange did not complete and the state of the server is
    /// unknown — the family a caller retries or reconnects on.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            ViiperError::Timeout { .. }
                | ViiperError::Io { .. }
                | ViiperError::StreamClosed { .. }
                | ViiperError::StreamTimeout { .. }
        )
    }

    /// The RFC 7807 status when the server answered with one.
    pub fn status(&self) -> Option<u16> {
        match self {
            ViiperError::Refused { problem, .. } | ViiperError::StreamRefused { problem, .. } => {
                Some(problem.status)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problem(status: u16) -> Problem {
        Problem {
            status,
            title: "Conflict".into(),
            detail: "Failed to auto-attach device".into(),
        }
    }

    #[test]
    fn the_three_families_never_overlap() {
        let addr: SocketAddr = "127.0.0.1:3342".parse().unwrap();
        let unreachable = ViiperError::Connect {
            addr,
            source: std::io::Error::other("refused"),
        };
        let refused = ViiperError::Refused {
            path: "bus/1/add".into(),
            problem: problem(409),
        };
        let transient = ViiperError::Timeout {
            path: "ping".into(),
            timeout: Duration::from_secs(2),
        };
        for (error, expect) in [
            (&unreachable, (true, false, false)),
            (&refused, (false, true, false)),
            (&transient, (false, false, true)),
        ] {
            assert_eq!(
                (
                    error.is_unreachable(),
                    error.is_refused(),
                    error.is_transient()
                ),
                expect,
                "{error}"
            );
        }
        assert_eq!(refused.status(), Some(409));
        assert_eq!(transient.status(), None);
    }

    #[test]
    fn refusals_carry_the_server_sentence_verbatim() {
        let error = ViiperError::Refused {
            path: "bus/1/add".into(),
            problem: problem(409),
        };
        let text = error.to_string();
        assert!(text.contains("409"), "{text}");
        assert!(text.contains("Failed to auto-attach device"), "{text}");
    }
}
