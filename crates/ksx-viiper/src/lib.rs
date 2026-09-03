//! ksx-viiper — the VIIPER output lane's protocol client.
//!
//! [VIIPER](https://github.com/Alia5/VIIPER) ("Virtual Input over IP
//! Emulator") is a GPL-3.0 Go server that materialises software-defined USB
//! devices — Xbox 360 pads, DualShock 4, DualSense, Switch 2 Pro, keyboards,
//! mice — through USB/IP. ksx never links it: the server is a separate process
//! (docs/ENHANCEMENTS.md E1.1 step 1) and this crate speaks its TCP API.
//!
//! Everything measured about that API on 2026-09-02 is in
//! `docs/research/viiper-2026.md`; the shape of this crate follows from four of
//! those facts:
//!
//! - **One connection per management call.** A request is `path [payload]\0`;
//!   the reply is one JSON line (or nothing) and the server closes the socket.
//!   [`client::ViiperClient`] opens, writes, reads to EOF and parses, with one
//!   deadline covering the whole exchange and a byte cap on the reply.
//! - **A device exists only while its stream is open.** After `bus/{b}/add`
//!   the client has 5 s to connect `bus/{b}/{d}\0`; after a stream drops it has
//!   5 s to reconnect, or the server reaps the device (a real USB unplug).
//!   [`stream::DeviceStream`] owns one such socket, with a bounded reader
//!   thread for feedback and timeouts on every write, so a stalled server can
//!   never hold a ksx thread.
//! - **Ids are reused.** A reaped device's `(bus, dev)` can be handed to the
//!   next `add`; a stale pair must be treated as dead the moment a removal or a
//!   failed reconnect is observed.
//! - **The server tracks no ownership and removes nothing on exit.** Any client
//!   may remove any device; a server that dies with devices attached leaves the
//!   usbip-win2 driver in a reattach storm. Clean teardown is therefore the
//!   client's job: [`stream::DeviceStream::close`], then
//!   [`client::ViiperClient::device_remove`], then `bus_remove`.
//!
//! Layout:
//! - [`wire`] — request framing, reply parsing, the RFC 7807 [`wire::Problem`]
//!   and the JSON DTOs.
//! - [`client`] — the blocking management client.
//! - [`stream`] — a device stream: reports out, feedback in.
//! - [`devices`] — byte-exact report codecs per device kind
//!   (`xbox360`, `dualshock4`, `keyboard`, `mouse`).
//! - [`usage_map`] — `ksx_core::Key` → USB HID keyboard usage.
//! - [`mock`] — an in-process fake server speaking the same protocol, so every
//!   caller is testable with no driver, no network and no GPL binary.
//! - [`error`] — [`error::ViiperError`].
//!
//! Nothing here touches the Windows driver, spawns the server, or knows about
//! personas: the supervisor and the `VirtualPadBackend` adapter are later
//! slices of the same lane and depend on this crate, not the reverse.

pub mod client;
pub mod devices;
pub mod error;
pub mod mock;
pub mod stream;
pub mod usage_map;
pub mod wire;

pub use client::ViiperClient;
pub use error::ViiperError;
pub use stream::{DeviceStream, StreamOptions};
pub use wire::{Device, DeviceCreateRequest, PingReply, Problem};

/// The upstream release this crate was written and measured against.
///
/// [`ViiperClient::ping_pinned`] refuses any other version: the wire formats
/// in [`devices`] are transcribed from this exact release and nothing here
/// promises to survive a protocol change silently.
pub const PINNED_SERVER_VERSION: &str = "0.7.0";

/// The `server` field a genuine VIIPER answers `ping` with.
pub const SERVER_NAME: &str = "VIIPER";
