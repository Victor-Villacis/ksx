//! The VIIPER management wire format.
//!
//! Measured against `viiper server` 0.7.0 (`docs/research/viiper-2026.md`
//! §2.1) and cross-checked against the generated Go/Rust clients:
//!
//! - A request is the path, optionally one space and a payload, then a single
//!   NUL byte. Payloads are JSON objects, decimal numbers or plain strings;
//!   newlines inside a payload are allowed.
//! - A reply is one JSON line (trailing `\n`) or nothing at all, and the server
//!   closes the connection to end it. There is no length prefix: read to EOF.
//! - An error is a one-line JSON object shaped like RFC 7807 Problem Details
//!   with a numeric `status` (`{"status":409,"title":"Conflict","detail":…}`).
//!   Success bodies never carry a `status` field, which is how the two are
//!   told apart.
//! - JSON field names are camelCase (`busId`, `devId`, `idVendor`,
//!   `deviceSpecific`).

use std::fmt;

use serde::{Deserialize, Serialize};

/// Terminates every request.
pub const REQUEST_TERMINATOR: u8 = 0;

/// Builds the bytes of one request.
///
/// `payload` is appended verbatim after one space; it is the caller's job to
/// pass valid JSON where the endpoint wants JSON. Returns `None` when the path
/// or payload contains a NUL, which the framing cannot carry.
pub fn encode_request(path: &str, payload: Option<&str>) -> Option<Vec<u8>> {
    if path.is_empty() || path.as_bytes().contains(&REQUEST_TERMINATOR) {
        return None;
    }
    if payload.is_some_and(|p| p.as_bytes().contains(&REQUEST_TERMINATOR)) {
        return None;
    }
    let mut bytes = Vec::with_capacity(path.len() + payload.map_or(0, |p| p.len() + 1) + 1);
    bytes.extend_from_slice(path.as_bytes());
    if let Some(payload) = payload {
        bytes.push(b' ');
        bytes.extend_from_slice(payload.as_bytes());
    }
    bytes.push(REQUEST_TERMINATOR);
    Some(bytes)
}

/// The stream handshake path for one device.
pub fn stream_path(bus: u32, dev: &str) -> String {
    format!("bus/{bus}/{dev}")
}

/// RFC 7807-shaped refusal as VIIPER sends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    /// HTTP-style code: 400, 404, 409, 500 observed.
    pub status: u16,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub detail: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.status, self.title)?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        Ok(())
    }
}

/// One parsed reply body.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// The server closed without a body — the documented success shape for
    /// endpoints that have nothing to say.
    Empty,
    /// A JSON success body.
    Json(serde_json::Value),
}

/// Why a reply could not be parsed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MalformedReply {
    #[error("reply is not UTF-8")]
    NotUtf8,
    #[error("reply is not JSON: {0}")]
    NotJson(String),
}

/// Parses the raw bytes read up to EOF.
///
/// `Ok(Err(problem))` is a refusal the server chose to send; `Err(_)` is a peer
/// that did not speak the protocol at all. Trailing newlines and stray NULs are
/// tolerated because a Go server writes `body\n` and nothing else.
pub fn parse_reply(bytes: &[u8]) -> Result<Result<Reply, Problem>, MalformedReply> {
    let text = std::str::from_utf8(bytes).map_err(|_| MalformedReply::NotUtf8)?;
    let text = text.trim_matches(|c: char| c == '\n' || c == '\r' || c == '\0' || c == ' ');
    if text.is_empty() {
        return Ok(Ok(Reply::Empty));
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| MalformedReply::NotJson(e.to_string()))?;
    if let Some(object) = value.as_object() {
        if object
            .get("status")
            .is_some_and(serde_json::Value::is_number)
        {
            if let Ok(problem) = serde_json::from_value::<Problem>(value.clone()) {
                return Ok(Err(problem));
            }
        }
    }
    Ok(Ok(Reply::Json(value)))
}

/// `ping` → `{"server":"VIIPER","version":"0.7.0"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PingReply {
    pub server: String,
    pub version: String,
}

/// `bus/list` → `{"buses":[1,2]}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusList {
    #[serde(default)]
    pub buses: Vec<u32>,
}

/// `bus/create` and `bus/remove` → `{"busId":1}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusReply {
    pub bus_id: u32,
}

/// One device as `bus/{b}/add` and `bus/{b}/list` describe it.
///
/// `vid`/`pid` are the hex strings the server prints (`"0x045e"`), kept as
/// strings because that is the wire truth and nothing in ksx recomputes them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub bus_id: u32,
    pub dev_id: String,
    #[serde(default)]
    pub vid: String,
    #[serde(default)]
    pub pid: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub device_specific: serde_json::Map<String, serde_json::Value>,
}

/// `bus/{b}/list` → `{"devices":[…]}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceList {
    #[serde(default)]
    pub devices: Vec<Device>,
}

/// `bus/{b}/remove <dev>` → `{"busId":1,"devId":"1"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRemoved {
    pub bus_id: u32,
    pub dev_id: String,
}

/// The payload of `bus/{b}/add`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCreateRequest {
    /// `xbox360`, `dualshock4`, `dualsense`, `dualsenseedge`, `ns2pro`,
    /// `keyboard`, `mouse` — see [`crate::devices::DeviceKind::type_name`].
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_vendor: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_product: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_specific: Option<serde_json::Value>,
}

impl DeviceCreateRequest {
    /// A request for `kind` with the server's default identity.
    pub fn of(kind: crate::devices::DeviceKind) -> Self {
        Self {
            kind: kind.type_name().to_owned(),
            id_vendor: None,
            id_product: None,
            device_specific: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_path_space_payload_nul() {
        assert_eq!(encode_request("ping", None).unwrap(), b"ping\0");
        assert_eq!(
            encode_request("bus/1/add", Some(r#"{"type":"keyboard"}"#)).unwrap(),
            b"bus/1/add {\"type\":\"keyboard\"}\0"
        );
        assert_eq!(
            encode_request("bus/create", Some("5")).unwrap(),
            b"bus/create 5\0"
        );
        assert!(encode_request("", None).is_none());
        assert!(encode_request("bus\0list", None).is_none());
        assert!(encode_request("bus/create", Some("5\0")).is_none());
    }

    #[test]
    fn replies_split_into_empty_json_and_problem() {
        assert_eq!(parse_reply(b"").unwrap(), Ok(Reply::Empty));
        assert_eq!(parse_reply(b"\n").unwrap(), Ok(Reply::Empty));
        let ok = parse_reply(b"{\"busId\":1}\n").unwrap().unwrap();
        assert_eq!(ok, Reply::Json(serde_json::json!({"busId": 1})));
        let problem = parse_reply(
            b"{\"status\":409,\"title\":\"Conflict\",\"detail\":\"Failed to auto-attach device\"}\n",
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(problem.status, 409);
        assert_eq!(problem.title, "Conflict");
        assert_eq!(
            problem.to_string(),
            "409 Conflict: Failed to auto-attach device"
        );
        assert!(matches!(
            parse_reply(b"not json"),
            Err(MalformedReply::NotJson(_))
        ));
        assert_eq!(parse_reply(&[0xff, 0xfe]), Err(MalformedReply::NotUtf8));
    }

    #[test]
    fn a_success_body_with_a_non_numeric_status_is_not_a_problem() {
        // `status` as a string is not the RFC 7807 shape the server emits.
        let reply = parse_reply(b"{\"status\":\"ok\"}").unwrap().unwrap();
        assert!(matches!(reply, Reply::Json(_)));
    }

    #[test]
    fn device_json_matches_the_measured_shape() {
        let json = r#"{"busId":1,"devId":"1","vid":"0x045e","pid":"0x028e","type":"xbox360","deviceSpecific":{"subType":1}}"#;
        let device: Device = serde_json::from_str(json).unwrap();
        assert_eq!(device.bus_id, 1);
        assert_eq!(device.dev_id, "1");
        assert_eq!(device.kind, "xbox360");
        assert_eq!(device.vid, "0x045e");
        assert_eq!(device.device_specific["subType"], 1);
        // Round trip keeps the camelCase names the server expects back.
        let text = serde_json::to_string(&device).unwrap();
        assert!(text.contains("\"busId\""), "{text}");
        assert!(text.contains("\"devId\""), "{text}");
        assert!(text.contains("\"deviceSpecific\""), "{text}");
    }

    #[test]
    fn create_request_omits_absent_fields() {
        let request = DeviceCreateRequest::of(crate::devices::DeviceKind::Keyboard);
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"type":"keyboard"}"#
        );
        let custom = DeviceCreateRequest {
            kind: "xbox360".into(),
            id_vendor: Some(0x045e),
            id_product: None,
            device_specific: Some(serde_json::json!({"subType": 7})),
        };
        assert_eq!(
            serde_json::to_string(&custom).unwrap(),
            r#"{"type":"xbox360","idVendor":1118,"deviceSpecific":{"subType":7}}"#
        );
    }

    #[test]
    fn stream_paths_follow_bus_dev() {
        assert_eq!(stream_path(1, "1"), "bus/1/1");
        assert_eq!(stream_path(7, "12"), "bus/7/12");
    }
}
