//! The client against the in-process mock: every measured behaviour the lane
//! depends on, with no driver and no network.

use std::time::{Duration, Instant};

use ksx_viiper::devices::{keyboard, xbox360, DeviceKind};
use ksx_viiper::mock::{MockOptions, MockServer};
use ksx_viiper::{DeviceStream, StreamOptions, ViiperClient, ViiperError, PINNED_SERVER_VERSION};

fn fast_reaper() -> MockOptions {
    MockOptions {
        reaper: Duration::from_millis(150),
        ..MockOptions::default()
    }
}

fn wait_until(deadline: Duration, mut done: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    done()
}

#[test]
fn ping_identifies_the_pinned_server() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let reply = client.ping_pinned(PINNED_SERVER_VERSION).unwrap();
    assert_eq!(reply.server, "VIIPER");
    assert_eq!(reply.version, "0.7.0");
}

#[test]
fn a_different_version_or_server_is_refused_as_unreachable() {
    let mock = MockServer::spawn(MockOptions {
        version: "0.8.0".into(),
        ..MockOptions::default()
    })
    .unwrap();
    let error = ViiperClient::new(mock.addr())
        .ping_pinned(PINNED_SERVER_VERSION)
        .unwrap_err();
    assert!(
        matches!(error, ViiperError::VersionMismatch { ref found, .. } if found == "0.8.0"),
        "{error}"
    );
    assert!(error.is_unreachable());

    let other = MockServer::spawn(MockOptions {
        server_name: "NOTVIIPER".into(),
        ..MockOptions::default()
    })
    .unwrap();
    let error = ViiperClient::new(other.addr())
        .ping_pinned(PINNED_SERVER_VERSION)
        .unwrap_err();
    assert!(matches!(error, ViiperError::NotViiper { .. }), "{error}");
    assert!(error.is_unreachable());
}

#[test]
fn nothing_listening_is_unreachable_within_the_deadline() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let client = ViiperClient::new(addr).with_deadline(Duration::from_millis(500));
    let started = Instant::now();
    let error = client.ping().unwrap_err();
    assert!(error.is_unreachable(), "{error}");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn bus_and_device_lifecycle_round_trips() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    assert!(client.bus_list().unwrap().is_empty());
    let bus = client.bus_create(None).unwrap();
    assert_eq!(bus, 1);
    assert_eq!(client.bus_list().unwrap(), vec![1]);
    assert_eq!(client.bus_create(Some(7)).unwrap(), 7);

    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    assert_eq!(pad.bus_id, 1);
    assert_eq!(pad.dev_id, "1");
    assert_eq!(pad.kind, "xbox360");
    assert_eq!(pad.vid, "0x045e");
    assert_eq!(pad.device_specific["subType"], 1);
    let keyboard = client.device_add_kind(bus, DeviceKind::Keyboard).unwrap();
    assert_eq!(keyboard.dev_id, "2");

    let listed = client.device_list(bus).unwrap();
    assert_eq!(
        listed.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(),
        ["xbox360", "keyboard"]
    );

    client.device_remove(bus, "1").unwrap();
    assert_eq!(client.device_list(bus).unwrap().len(), 1);
    // Ids are reused, as measured on the real server.
    let again = client.device_add_kind(bus, DeviceKind::Mouse).unwrap();
    assert_eq!(again.dev_id, "1");

    client.bus_remove(bus).unwrap();
    assert_eq!(client.bus_list().unwrap(), vec![7]);
    let error = client.device_list(bus).unwrap_err();
    assert!(error.is_refused());
    assert_eq!(error.status(), Some(404));
    assert_eq!(
        mock.request_log().first().map(String::as_str),
        Some("bus/list")
    );
}

#[test]
fn a_stream_keeps_the_device_alive_and_carries_reports_and_feedback() {
    let mock = MockServer::spawn(fast_reaper()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();

    let mut stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        DeviceKind::Xbox360.stream_options(),
    )
    .unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock.is_streaming(bus, 1)));

    let report = xbox360::encode(&ksx_core::PadState {
        buttons: ksx_core::pad::XButtons::A,
        ..Default::default()
    });
    stream.send(&report).unwrap();
    stream.send(&xbox360::encode(&Default::default())).unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock
        .received(bus, 1)
        .len()
        == 40));
    assert_eq!(&mock.received(bus, 1)[..20], &report);

    // Well past the reaper: the stream is what keeps the device.
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        mock.devices(bus).len(),
        1,
        "a streaming device is never reaped"
    );

    assert!(mock.push_feedback(bus, 1, &[0x40, 0x80]));
    assert!(wait_until(Duration::from_secs(1), || stream
        .poll_feedback()
        .is_some_and(|p| p == [0x40, 0x80])));
    assert_eq!(stream.dropped_feedback(), 0);

    stream.close();
    assert!(wait_until(Duration::from_secs(1), || !mock.is_streaming(bus, 1)));
    assert!(
        wait_until(Duration::from_secs(2), || mock.devices(bus).is_empty()),
        "a device whose stream dropped is reaped after the handler timeout"
    );
}

#[test]
fn a_device_never_streamed_is_reaped_after_the_handler_timeout() {
    let mock = MockServer::spawn(fast_reaper()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    client.device_add_kind(bus, DeviceKind::Keyboard).unwrap();
    assert_eq!(mock.devices(bus).len(), 1);
    assert!(wait_until(Duration::from_secs(2), || mock
        .devices(bus)
        .is_empty()));
    assert_eq!(client.device_list(bus).unwrap().len(), 0);
}

#[test]
fn a_failed_auto_attach_is_a_409_that_leaves_an_orphan() {
    let mock = MockServer::spawn(MockOptions {
        fail_attach: true,
        ..fast_reaper()
    })
    .unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let error = client
        .device_add_kind(bus, DeviceKind::Keyboard)
        .unwrap_err();
    assert_eq!(error.status(), Some(409), "{error}");
    assert!(
        error.to_string().contains("Failed to auto-attach"),
        "{error}"
    );
    // The orphan is visible until the reaper takes it — a client that
    // retries `add` in a loop would accumulate them.
    assert_eq!(client.device_list(bus).unwrap().len(), 1);
    assert!(wait_until(Duration::from_secs(2), || mock
        .devices(bus)
        .is_empty()));
}

#[test]
fn an_unknown_device_stream_is_refused_inline() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let error = DeviceStream::open(mock.addr(), bus, "9", DeviceKind::Xbox360.stream_options())
        .unwrap_err();
    assert!(
        matches!(error, ViiperError::StreamRefused { .. }),
        "{error}"
    );
    assert_eq!(error.status(), Some(404));
    assert!(
        error.to_string().contains("device 9 not found on bus 1"),
        "{error}"
    );
}

#[test]
fn a_stream_notices_the_device_being_removed_under_it() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    let mut stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        DeviceKind::Xbox360.stream_options(),
    )
    .unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock.is_streaming(bus, 1)));
    client.bus_remove(bus).unwrap();
    assert!(wait_until(Duration::from_secs(1), || stream.is_closed()));
    let error = stream
        .send(&xbox360::encode(&Default::default()))
        .unwrap_err();
    assert!(matches!(error, ViiperError::StreamClosed { .. }), "{error}");
    assert!(error.is_transient());
}

#[test]
fn a_silent_server_costs_exactly_the_deadline() {
    let mock = MockServer::spawn(MockOptions {
        hang_replies: true,
        ..MockOptions::default()
    })
    .unwrap();
    let client = ViiperClient::new(mock.addr()).with_deadline(Duration::from_millis(300));
    let started = Instant::now();
    let error = client.ping().unwrap_err();
    let elapsed = started.elapsed();
    assert!(matches!(error, ViiperError::Timeout { .. }), "{error}");
    assert!(error.is_transient());
    assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    mock.shutdown();
}

#[test]
fn an_oversized_reply_is_refused_not_buffered() {
    let mock = MockServer::spawn(MockOptions {
        oversize_replies: true,
        ..MockOptions::default()
    })
    .unwrap();
    let error = ViiperClient::new(mock.addr()).ping().unwrap_err();
    assert!(
        matches!(error, ViiperError::ReplyTooLarge { max, .. } if max == ViiperClient::MAX_REPLY_BYTES),
        "{error}"
    );
}

#[test]
fn keyboard_packets_reach_the_server_verbatim() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let kb = client.device_add_kind(bus, DeviceKind::Keyboard).unwrap();
    let mut stream = DeviceStream::open(
        mock.addr(),
        bus,
        &kb.dev_id,
        DeviceKind::Keyboard.stream_options(),
    )
    .unwrap();
    let mut state = keyboard::KeyboardState::new();
    state.press(keyboard::Usage::Modifier(keyboard::modifier::LEFT_SHIFT));
    state.press(keyboard::Usage::Key(0x04));
    stream.send(&state.encode()).unwrap();
    stream
        .send(&keyboard::KeyboardState::NEUTRAL_PACKET)
        .unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock.received(bus, 1)
        == [0x02, 1, 0x04, 0, 0]));
    assert!(mock.push_feedback(bus, 1, &[keyboard::Leds::CAPS_LOCK]));
    assert!(wait_until(Duration::from_secs(1), || {
        stream
            .poll_feedback()
            .and_then(|p| keyboard::Leds::decode(&p))
            .is_some_and(|leds| leds.caps_lock)
    }));
}

#[test]
fn closing_a_stream_is_bounded_even_with_a_quiet_peer() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    let stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        StreamOptions {
            feedback_queue: 1,
            ..DeviceKind::Xbox360.stream_options()
        },
    )
    .unwrap();
    let started = Instant::now();
    stream.close();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn feedback_overflow_evicts_the_oldest_so_the_newest_state_survives() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    let stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        StreamOptions {
            feedback_queue: 2,
            ..DeviceKind::Xbox360.stream_options()
        },
    )
    .unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock.is_streaming(bus, 1)));
    for i in 0..5_u8 {
        mock.push_feedback(bus, 1, &[i, i]);
    }
    assert!(wait_until(Duration::from_secs(1), || stream
        .dropped_feedback()
        == 3));
    // Feedback is state, not events: a game's final "rumble off" must be the
    // packet that survives a burst, never the first one of it.
    assert_eq!(stream.poll_feedback(), Some(vec![3, 3]));
    assert_eq!(stream.poll_feedback(), Some(vec![4, 4]));
    assert_eq!(stream.poll_feedback(), None);
}

#[test]
fn feedback_waiting_when_the_stream_opens_is_delivered_not_fatal() {
    // A keyboard's host pushes LED state the moment the device attaches, and a
    // pad reconnected inside the reaper window may have rumble pending: bytes
    // inside the refusal window are feedback unless they are a problem line.
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let kb = client.device_add_kind(bus, DeviceKind::Keyboard).unwrap();
    assert!(mock.push_feedback(bus, 1, &[keyboard::Leds::CAPS_LOCK]));
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    assert!(mock.push_feedback(bus, 2, &[0x40, 0x80]));
    assert!(mock.push_feedback(bus, 2, &[0x00, 0x00]));

    let stream = DeviceStream::open(
        mock.addr(),
        bus,
        &kb.dev_id,
        DeviceKind::Keyboard.stream_options(),
    )
    .unwrap();
    assert!(wait_until(Duration::from_secs(1), || {
        stream
            .poll_feedback()
            .and_then(|p| keyboard::Leds::decode(&p))
            .is_some_and(|leds| leds.caps_lock)
    }));
    assert!(!stream.is_closed());

    let pad_stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        DeviceKind::Xbox360.stream_options(),
    )
    .unwrap();
    assert!(wait_until(Duration::from_secs(1), || pad_stream
        .poll_feedback()
        .is_some_and(|p| p == [0x40, 0x80])));
    assert!(wait_until(Duration::from_secs(1), || pad_stream
        .poll_feedback()
        .is_some_and(|p| p == [0x00, 0x00])));
    assert!(!pad_stream.is_closed());
}

#[test]
fn a_refusal_that_arrives_after_the_window_still_refuses_the_stream() {
    // A loaded or remote server can answer the handshake later than the
    // 100 ms window. The reader must recognise the problem line instead of
    // decoding its bytes as phantom feedback.
    let mock = MockServer::spawn(MockOptions {
        refusal_delay: Duration::from_millis(250),
        ..MockOptions::default()
    })
    .unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let mut stream =
        DeviceStream::open(mock.addr(), bus, "9", DeviceKind::Xbox360.stream_options()).unwrap();
    assert!(!stream.is_closed(), "the window passed before the refusal");
    assert!(wait_until(Duration::from_secs(2), || stream.is_closed()));
    assert_eq!(
        stream.poll_feedback(),
        None,
        "a refusal line is never feedback"
    );
    let refusal = stream
        .refusal()
        .expect("the late problem line was recorded");
    assert_eq!(refusal.status, 404);
    let error = stream
        .send(&xbox360::encode(&Default::default()))
        .unwrap_err();
    assert!(
        matches!(error, ViiperError::StreamRefused { .. }),
        "{error}"
    );
    assert_eq!(error.status(), Some(404));
}

#[test]
fn a_zero_write_timeout_is_clamped_not_fatal() {
    let mock = MockServer::spawn(MockOptions::default()).unwrap();
    let client = ViiperClient::new(mock.addr());
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    let mut stream = DeviceStream::open(
        mock.addr(),
        bus,
        &pad.dev_id,
        StreamOptions {
            write_timeout: Duration::ZERO,
            refusal_wait: Duration::ZERO,
            ..DeviceKind::Xbox360.stream_options()
        },
    )
    .unwrap();
    stream.send(&xbox360::encode(&Default::default())).unwrap();
    assert!(wait_until(Duration::from_secs(1), || mock
        .received(bus, 1)
        .len()
        == 20));
}

/// Opt-in conformance run against a real server: `KSX_VIIPER_LIVE_ADDR=127.0.0.1:3342`.
#[cfg(feature = "viiper-live-tests")]
#[test]
fn live_server_speaks_the_same_protocol_as_the_mock() {
    let addr: std::net::SocketAddr = std::env::var("KSX_VIIPER_LIVE_ADDR")
        .expect("KSX_VIIPER_LIVE_ADDR")
        .parse()
        .expect("socket address");
    let client = ViiperClient::new(addr);
    client.ping_pinned(PINNED_SERVER_VERSION).unwrap();
    let bus = client.bus_create(None).unwrap();
    let pad = client.device_add_kind(bus, DeviceKind::Xbox360).unwrap();
    let mut stream =
        DeviceStream::open(addr, bus, &pad.dev_id, DeviceKind::Xbox360.stream_options()).unwrap();
    stream.send(&xbox360::encode(&Default::default())).unwrap();
    let refused =
        DeviceStream::open(addr, bus, "99", DeviceKind::Xbox360.stream_options()).unwrap_err();
    assert_eq!(refused.status(), Some(404), "{refused}");
    stream.close();
    client.device_remove(bus, &pad.dev_id).unwrap();
    client.bus_remove(bus).unwrap();
}
