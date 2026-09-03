//! Conformance probe against a live `viiper server`.
//!
//! ```text
//! cargo run -p ksx-viiper --example probe -- 127.0.0.1:3342 [xbox360|keyboard|mouse] [--hold-secs N] [--press]
//! ```
//!
//! Pings, creates a bus, adds one device, opens its stream, sends neutral
//! reports (and, only with `--press`, one press/release of A or the `a` key —
//! which TYPES on a machine where the driver is installed), prints any
//! feedback, then removes the device and the bus. Every step prints its
//! timing so the research note can quote it.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use ksx_viiper::devices::{keyboard, mouse, xbox360, DeviceKind};
use ksx_viiper::{DeviceStream, ViiperClient, PINNED_SERVER_VERSION};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(addr) = args.next() else {
        eprintln!("usage: probe <api-addr> [xbox360|keyboard|mouse] [--hold-secs N] [--press]");
        std::process::exit(2);
    };
    let addr: SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad address {addr:?}: {e}");
            std::process::exit(2);
        }
    };
    let mut kind = DeviceKind::Xbox360;
    let mut hold = Duration::from_secs(2);
    let mut press = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--hold-secs" => {
                hold = Duration::from_secs(args.next().and_then(|s| s.parse().ok()).unwrap_or(2));
            }
            "--press" => press = true,
            other => match DeviceKind::from_type_name(other) {
                Some(k) => kind = k,
                None => {
                    eprintln!("unknown argument {other:?}");
                    std::process::exit(2);
                }
            },
        }
    }

    let client = ViiperClient::new(addr);
    let t = Instant::now();
    match client.ping_pinned(PINNED_SERVER_VERSION) {
        Ok(reply) => println!(
            "ping   {:>6?}  {} {}",
            t.elapsed(),
            reply.server,
            reply.version
        ),
        Err(e) => {
            eprintln!("ping failed: {e}");
            std::process::exit(1);
        }
    }

    let t = Instant::now();
    let bus = client
        .bus_create(None)
        .unwrap_or_else(|e| fail("bus/create", e));
    println!("bus    {:>6?}  busId={bus}", t.elapsed());

    let t = Instant::now();
    let device = client
        .device_add_kind(bus, kind)
        .unwrap_or_else(|e| fail("add", e));
    println!(
        "add    {:>6?}  dev={} vid={} pid={} type={}",
        t.elapsed(),
        device.dev_id,
        device.vid,
        device.pid,
        device.kind
    );

    let t = Instant::now();
    let mut stream = DeviceStream::open(addr, bus, &device.dev_id, kind.stream_options())
        .unwrap_or_else(|e| fail("stream", e));
    println!("stream {:>6?}  {}", t.elapsed(), stream.path());

    let neutral: Vec<u8> = match kind {
        DeviceKind::Xbox360 => xbox360::encode(&Default::default()).to_vec(),
        DeviceKind::Keyboard => keyboard::KeyboardState::NEUTRAL_PACKET.to_vec(),
        DeviceKind::Mouse => mouse::MouseReport::default().encode().to_vec(),
        other => {
            eprintln!("no probe report for {}", other.type_name());
            std::process::exit(2);
        }
    };
    stream.send(&neutral).unwrap_or_else(|e| fail("send", e));

    if press {
        let pressed: Vec<u8> = match kind {
            DeviceKind::Xbox360 => xbox360::encode(&ksx_core::PadState {
                buttons: ksx_core::pad::XButtons::A,
                ..Default::default()
            })
            .to_vec(),
            DeviceKind::Keyboard => {
                let mut state = keyboard::KeyboardState::new();
                state.press(keyboard::Usage::Key(0x04));
                state.encode()
            }
            DeviceKind::Mouse => mouse::MouseReport {
                buttons: mouse::button::LEFT,
                ..Default::default()
            }
            .encode()
            .to_vec(),
            _ => unreachable!(),
        };
        let t = Instant::now();
        stream.send(&pressed).unwrap_or_else(|e| fail("press", e));
        std::thread::sleep(Duration::from_millis(120));
        stream.send(&neutral).unwrap_or_else(|e| fail("release", e));
        println!("press  {:>6?}  press+release sent", t.elapsed());
    }

    let until = Instant::now() + hold;
    let mut feedback = 0;
    while Instant::now() < until {
        while let Some(packet) = stream.poll_feedback() {
            feedback += 1;
            println!("feedback {packet:02x?}");
        }
        if stream.is_closed() {
            println!("stream closed by the server");
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    println!(
        "held   {hold:?}  feedback packets={feedback} dropped={}",
        stream.dropped_feedback()
    );

    stream.close();
    let t = Instant::now();
    client
        .device_remove(bus, &device.dev_id)
        .unwrap_or_else(|e| fail("remove", e));
    client
        .bus_remove(bus)
        .unwrap_or_else(|e| fail("bus/remove", e));
    println!("clean  {:>6?}  device and bus removed", t.elapsed());
}

fn fail(step: &str, error: ksx_viiper::ViiperError) -> ! {
    eprintln!("{step} failed: {error}");
    std::process::exit(1);
}
