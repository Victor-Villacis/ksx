# Universal I/O — any device in, any device out

**Status:** plan approved 2026-08-21, M11 started. This document is the
governing record for the expansion; `docs/ARCHITECTURE.md`'s milestone table
carries M11–M19 rows pointing here.

> **Reading this cold?** Start at §0, then §7 (what is already done), then the
> milestone you are picking up. Every claim below carries a `file:line` so you
> can verify rather than trust. Where this document and another disagree, check
> `docs/HIDMAESTRO-STATE.md` first — that file wins on HIDMaestro facts.

---

## 0. What this is

ksx today is a keyboard splitter that publishes XInput-shaped pad state. The
product this plan builds is different in kind, and Victor stated it directly:

> "we will have all types of devices possible that can be detected by the pc for
> us to use to send signals to the controller … nothing can be left on the
> table … we need to be the defacto that reWASD and others are not … the
> complete stop for emulation of all controllers."

and, on output:

> "this product will read more than keyboards and it will take all series of
> devices like we do now and output to not just controllers but also keyboards
> if wanted to so people can use this app for macros etc."

So: **any device in, any device out.**

Four expansions:

1. **Any device is a source.** Mice, real gamepads, Wii Remotes, spinners,
   trackballs, dance mats, HOTAS — anything Windows enumerates — with analog
   staying analog end to end.
2. **Every field every backend can express is drivable.** Trigger pressure,
   touchpad click and coordinates, Share/Create/Capture/mic, paddles, motion,
   battery, full stick resolution.
3. **Feedback flows both ways.** Rumble, LED slot, impulse triggers, lightbar,
   adaptive-trigger requests and audio-haptic streams that games send are
   received and forwarded to sinks (cabinet LEDs, Studio, a real pad).
4. **Output is not only pads.** A virtual keyboard (and mouse) as an output
   target, so one physical input can produce keystrokes — macros, cabinet admin
   keys, per-game hotkeys. See §6.

Plus precision as a first-class feature: pressure ladders (Q = 10 %, W = 20 %…),
per-axis deadzone/saturation/curves, 4-way restriction, tap/hold/double-tap.

### Decisions already taken — do not reopen without Victor

| Question | Decision |
|---|---|
| Wii / Bluetooth capture | **Adopt an existing stack** (HidHide for hiding HID pads; a DolphinBar-class path for Wii). No ksx-authored driver. |
| Rich output effects | **Fork the HIDMaestro SDK** (user-mode .NET) so vendor-blob regions become writable. **Not** the driver. |
| Sequencing | **Precision → sources → effects → catalog → key output.** Every stage independently shippable. |
| Arcade scope | **Expose what the catalog already carries** rather than choosing device classes up front. |

---

## 1. What the survey found

### The good news, and it is substantial

- **The engine was never coupled to `Key` being a closed enum.** It is coupled
  to the dispatch key being `Copy + Hash + Eq` and interned into dense ids
  (`crates/ksx-core/src/engine.rs:1250`). `HashMap<Key,u32>` →
  `HashMap<SourceControl,u32>` is a *type substitution*: `targets`, `down`,
  `held`, `consumed`, `blocked`, the holder-id ordering and the whole transform
  stack are untouched.
- **Full stick resolution needs no fork and no protocol change.** The 8-bit
  quantisation is entirely ours, in
  `tools/hidmaestro-sdk-host/SdkStateMapper.cs:365-372`; the SDK surface is
  already `Dictionary<HMAxis,float>`. Xbox Series descriptors are 16-bit and
  Switch Pro 12-bit.
- **Feedback decoders are finished and frozen** — XInput vibration (including
  impulse-trigger magnitudes), Xbox Series BT, Xbox legacy, and a full
  DualSense reducer with 16 golden vectors
  (`crates/ksx-hidmaestro/src/{feedback,dualsense_feedback}.rs`,
  `tools/hidmaestro-feedback-contract/`). The C# host simply never emits a
  frame (`runtime-contract-sdk.json`: `"feedback": "none in v1"`). Highest
  done-work-to-remaining-work ratio in the project.
- **The Switch Pro IMU slice is reachable without touching the driver.** The
  driver already reads body bytes 12..47 when 48 bytes arrive; ksx already
  sends 48 with 36 zeros (`docs/HIDMAESTRO-STATE.md:120-140`).
- **The catalog is 130 deployable profiles across 32 vendors** — Xbox Elite
  v1/v2 and DualSense Edge (**paddles**), `xbox-360-arcade-stick`,
  `xbox-360-dance-pad`, two guitars, flight sticks (T16000M, HOTAS 4/One, X52,
  Sidewinder FFB2), ~35 racing wheels (Logitech G25/G27/G29/G920/G923,
  Thrustmaster T300/T500/TX, TH8A shifter, pedals), Steam Deck, Stadia, Luna.
  No drums. No keyboards/mice — that is the VIIPER lane (§6).
- **Mouse pseudo-keys are already reserved** (`Key` 20001..=20013,
  `crates/ksx-core/src/key.rs:183-195`).

### The real costs

- **`KeyEvent { device, key, down, t }` is digital-only**
  (`crates/ksx-core/src/device.rs:53-64`) and is the bottleneck for every
  analog source. Already named in
  `docs/research/INPUT-TOPOLOGY-AND-ANTICHEAT.md:63-67`: *"A real stick has
  nowhere to land in that type."*
- **Hiding is the expensive half of any new source.** Without it the game reads
  the real device *and* the ksx pad.
- **Same-control/different-value conflicts were an unfixed bug.** ✅ **FIXED in
  M11 piece 2.** Hold `lx.8000` + `lx.16000`, release the larger → the axis
  snapped to 0 while the smaller was still held, because `endpoint_keys` is
  keyed by the *whole* `Binding` and `opposite_snap` only mediated
  opposite-sign holders on release. Pressure ladders hit this on the first
  press. Now pinned by
  `same_sign_ladder_release_falls_back_instead_of_centering`.
- **The control vocabulary is pinned at 25 in fixed-size arrays** —
  `zones_for() -> &'static [Zone; 25]` (`crates/ksx-studio/src/render_map.rs:280`,
  17 call sites), `FUNCTIONS: [&str; 25]` (`:3507`), `MACRO_COLUMN_COUNT = 37`
  (`:2621`), two insta golden snapshots, and hand-written TypeScript mirrors
  (`studio-ui/src/MapIsland.ts:447-501`, `MapPage.ts:234-265`).
- **No per-persona capability model exists.** `Persona` knows only
  backend/xinput/hat/feedback/plug/limit; presets are not bound to a persona.
- **ksx sets 11 of HIDMaestro's 18 button bits and 6 of its 41 axis usages.**

### One correction to the ask

**Lightbar, adaptive triggers and audio haptics are INBOUND on a virtual pad** —
the game writes them to us. Nothing consumes a virtual pad reporting its own
lightbar. So they belong to the feedback milestone (M17), not the output
vocabulary. Outbound is: pressure, touchpad click + XY, share/capture/mic,
paddles, motion, battery, stick resolution.

### Ground already taken — do not re-litigate

XInput as a read path (**permanently** — it would read a namespace containing
ksx's own ViGEm output); gamepad→keystrokes inside ksx as a *substitute* for
real key output; RawInput + low-level-hook correlation for blocking;
`SendInput`-based key output feeding MAME (MAME's Raw Input path drops
null-`hDevice` events); any detection evasion; shipping a kernel-mode driver
(Dev Center + EV cert; Azure Trusted Signing cannot sign drivers); ViGEm DS4
feedback (no notification IOCTL exists — the PlayStation persona can never
receive rumble, `crates/ksx-core/src/persona.rs:313-317`).

---

## 2. Architecture

### Input

One event type, a widened *address*, digital as the degenerate case:

```rust
// crates/ksx-core/src/source.rs  (NEW)
pub enum SourceControl { Key(Key), Hid { page: u16, usage: u16, index: u8 } }
pub struct Value(pub i16);   // bipolar / unipolar / button. i16, never f32.
pub struct InputEvent { device: DeviceId, control: SourceControl, value: Value, t: u64 }
```

- `Value` is `i16` because `KeyEvent` derives `Hash + Eq` and so must its
  successor, and because float transforms are a determinism hazard between the
  CI runner and the cabinet.
- `KeyEvent` **stays byte-identical** with `From`/`TryFrom`, and
  `Engine::handle_at` delegates to `handle_input_at`. That is why every engine
  test and the pinned replay digest survive untouched.
- Analog state is a dense `values: Vec<i16>` sized in `EngineTables::build`;
  `analog_count == 0` is the checkable "this session predates analog", the same
  one-branch shape `chords.is_empty()` already gives.
- One spelling per control, used by TOML, the `--record` corpus, the pipe and
  Studio: `SourceControl::name()` → `A` or `hid:1:48:0`.

### Output

The XInput seven stay in XInput wire shape; everything else is a sub-struct:

```rust
pub struct PadState { buttons, lt, rt, lx, ly, rx, ry, extras: Extras }
pub struct Extras { aux: AuxButtons, touch: TouchPoint, motion: Motion, battery: Battery }
```

`AuxButtons` bit positions are **numerically identical to HIDMaestro's
`HMButton`** (`crates/ksx-hidmaestro/src/state.rs:31-55`), so the C# mapper is
one OR and that equality is a test. `XButtons`' single free bit (0x0800) stays
**reserved** — it is XInput-reserved and buys 1 of 9 needed bits.

### The resolver — one rule replaces `opposite_snap`

> A digital control is the OR of its holders. **An analog control takes the
> sign of the most recent rising demand on that axis and, among currently-held
> holders of that sign, the largest magnitude**; a control with no holder is
> neutral. **Zero is a sign of its own** — `lx.0` is a demand for *centre*, not
> a weak positive. When the most recent sign has no holder left, the axis falls
> back to the largest deflection still held, so a centre demand yields to a real
> one. Press and release run the same function over the post-event holder set.

The ladder bug stops being possible, and every existing behaviour is a special
case — but **not** of the rule as this document first stated it.

> ⚠️ **Amended 2026-08-21, during M11 piece 2.** The original wording was
> *"the demand with the largest magnitude among currently-held holders; the
> most recent press breaks a magnitude tie"*, annotated "verified case-by-case
> in the design". That claim was false and the rule does not ship.
> `socd_model_holds` (`crates/ksx-core/tests/engine_proptests.rs:258-297`)
> draws `vmin` and `vmax` *independently* and asserts that a press yields the
> pressed key's **own** value unconditionally, so magnitude-primary fails on
> minimal input `vmin = -16384, vmax = 32767` — measured, by installing that
> rule and running the test. Recency has to be **primary over sign**, with
> magnitude arbitrating **within** a sign.
>
> The amended rule is also *cheaper*: because magnitude decides within a sign,
> the only ordering it consumes is which sign rose last — `[bool; 4]` per slot
> (`SlotRuntime::axis_pos_last`), not a per-holder press stamp. That matters,
> because holder-indexed arrays do not exist on non-stateful slots, which is
> exactly where the axis suites run. It is also what makes SOCD's "last press
> wins" fall out for free: `AXIS_MIN` and `AXIS_MAX` are ±32767, an exact
> magnitude tie that no comparison of deflections could ever break.

### ⚠️ Naming collision to settle before coding

Both designs introduced a type called `Control`. They are different things:

| | meaning | home |
|---|---|---|
| `SourceControl` | the **address** of a physical control on a source device | `crates/ksx-core/src/source.rs` |
| `PadControl` | the **endpoint** a binding drives on a virtual pad | `crates/ksx-core/src/control.rs` |

Do not let either be called `Control`.

---

## 3. Milestones

House format (`docs/ARCHITECTURE.md:60`): acceptance is a **measured or
physical** result, never a code state.

| M | Scope | Acceptance target |
|---|---|---|
| **M11** | **The vocabulary can grow** (pure refactor, no user-visible change) | Workspace green with every existing test **unchanged**; `adding_a_function_to_the_vocabulary_needs_no_array_edit` passes; both insta snapshots byte-identical; `node build.mjs` byte-identical; cabinet `ksx doctor --latency` p99 unmoved |
| **M12** | **Analog authoring** — pressure, ladders, curves, gates, tap/hold | A 5-step ladder publishes 5 distinct `rt` values in a replay; existing presets round-trip byte-identically; curve tables give identical digests on CI and cabinet; joy.cpl shows intermediate stick travel on an Xbox Series pad |
| **M13** | **The input event grows up** (invisible) | `SESSION_DIGEST` unmoved; cabinet p99 unmoved; every existing `config.toml`/`games.toml` byte-identical after load+save; `ksx devices` lists a gamepad |
| **M14** | **Real devices drive pads** — HID + mouse readers, `[axes]`, hiding | Cabinet: a DS4 and the I-PAC both drive slot 1; a WinUSB-claimed DS4 vanishes from `joy.cpl` while still driving; a Wii Remote's pitch drives `ry`; `--dry-run` prints the hiding route per source |
| **M15** | **Rich output vocabulary** — extras, aux buttons, capability model, protocol v2 | Touchpad click reaches a real DS4 target; the capability invariant test holds (no `[bindings]` row is ever a hard error under any persona); v1 host + v2 client degrades with a named reason and working pads |
| **M16** | **The SDK fork** — touch XY, IMU, battery reach devices | CI re-derives the fork from verified upstream + patches and matches `forkSha256`; gyro moves in a Switch emulator; touchpad XY registers in a PS5-era title; every `excludedState` removal arrives with a golden vector |
| **M17** | **Feedback both ways** | A game's rumble lights a cabinet button through the E8 sink bus; SSE JSON byte-identical for a no-extras frame; `has_feedback` flips for Switch Pro only in the commit that adds its decode |
| **M18** | **Catalog breadth + arcade** | Each newly exposed persona spawns and passes a joy.cpl press-check; six-button fighters map correctly in MAME via `ksx export mame-ctrlr` |
| **M19** | **Key output** — a binding can produce keystrokes (§6) | A macro bound to one panel button types a key sequence into Notepad **and** into MAME; the same preset drives a pad and a keyboard at once; every exit path releases every held key |

### M11 — the vocabulary can grow

Four independent pieces, each shippable alone:

1. **Kill the fixed arrays** — ✅ **DONE**, see §7. The generated
   `zones.gen.ts` is **deferred**; a drift pin ships in its place.

   > ⚠️ **Four premises in this bullet's original wording were wrong**, found
   > while implementing it on 2026-08-21. They are corrected in §7 rather than
   > silently rewritten here, because the reasoning is the useful part:
   >
   > - *"`zones_for` … derives from `ksx_core::preset::mappable_functions()`"* —
   >   **impossible, and undesirable.** `ksx-studio` links `ksx-api` and
   >   nothing else at runtime; `ksx-core` and `ksx-config` are
   >   `[dev-dependencies]` and their manifest comments say so deliberately
   >   ("this crate renders and routes and knows nothing about the key
   >   vocabulary at runtime"). Following the instruction would have broken the
   >   boundary `docs/M9-DECISION.md` §6 exists to hold. A `Zone` is also
   >   persona **art** — label, geometry, palette — which ksx-core has no
   >   business knowing.
   > - *"`mappable_functions()`"* returns names — **no.** ksx-core carries no
   >   spellings at all; `function_name` lives in ksx-config. It returns
   >   `&'static [Binding]`.
   > - *"today's order keeps both snapshots byte-identical"* — true, but not for
   >   that reason. `PresetFile::bindings` is a `BTreeMap`, so the emitted TOML
   >   is alphabetical and **order-blind**; only the set and the spellings
   >   matter.
   > - *"`studio-ui/src/zones.gen.ts` becomes generated"* — that file has never
   >   existed. The mirrors are hand-written literals in `MapIsland.ts` and
   >   `MapPage.ts`.
2. **`PadControl` + the resolver**; delete `opposite_snap` — ✅ **DONE**,
   see §7.
3. **`DeviceId(Arc<str>)`** — ✅ **DONE**, see §7.
4. **`SdkStateMapper.Axis()` full precision** — derive the profile's logical
   range instead of assuming 8 bits. Needs new per-profile golden vectors
   proving distinct intermediate values reach the packed body.

### M12 — analog authoring

- `Binding::Pressure { trigger, value }` as a **separate variant** from
  `Trigger`, plus `Binding::canonical()` folding full-scale pressure back to
  `Trigger`. That is the only shape where `"lt"` keeps its bytes — every preset
  file and both golden snapshots depend on it. `"lt.0"` is an error: a binding
  that presses nothing is not a binding.
- Ladders: `"rt.10%" = "Q"` accepted and **emitted in the unit authored** (the
  macro-step `ms`/`frames` precedent, `preset.rs:242-247`). Ship
  `ksx preset ladder --function rt --keys Q,W,E,R,T --steps 5`, because typing
  five rows by hand is how a ladder gets an off-by-one.
- Shaping is **integer tables only**: a 33-sample `CurveTable`, precomputed
  reciprocals, no divides, no branches on data, no floats.
- `restrict = "4way" | "8way" | "circle"` at preset level, slot-overridable.
  `circle` (clamp vector magnitude) is the one most 3D games need and nobody
  asks for by name — a digital diagonal on a square gate reads as 1.41× speed.
- **Tap/hold/double-tap contradicts a stated principle** (`INPUT-TRANSFORMS.md`
  §1b: "ksx consumes, and never defers"). Implement it **opt-in per row, with
  the millisecond cost printed every run**, and refuse guard + tap/hold on one
  row. Hold-only costs zero latency — ship that first; it is most of the value.

### M13 — the input event grows up

`SourceControl` / `Value` / `InputEvent`. `CaptureBackend::run` changes channel
type in one mechanical commit — two `run` methods would be the second-clock
mistake in trait form. `SlotSpec.sources: Vec<SourceSpec>` replaces
`keyboard`/`mouse`, which become **derived accessors** so the ~30 construction
sites do not move; `SlotSpec::new` keeps its exact signature. Legacy TOML stays
valid **and stays the emitted form when sufficient**; mixing both spellings is
refused rather than merged.

### M14 — real devices drive pads

Readers, in order: Raw Input HID (`RIM_TYPEHID` + `HidP_*`, **digital buttons
first**), Raw Input mouse, then WinUSB claim generalized past keyboards.
**Two HID parsers is correct and the code must say so** — a WinUSB-claimed
interface has no `hidclass.sys` above it; on Raw Input, Windows already parsed
the descriptor and `HidP_*` is the supported API.

Hiding, honestly:

| route | hides | cannot |
|---|---|---|
| WinUSB claim | **everything, structurally** — no device left to enumerate | Bluetooth; vendor-class GIP (Xbox pads) |
| HidHide (**IOCTL only**, never `HidHideCLI.exe` — it crashes on 25H2, issue #215) | HID pads including Bluetooth | keyboards, mice (issue #4), and XInput reliably (issue #39) |
| Raw Input alone | nothing | — |

`DeviceInfo` gains `hiding: Hiding` (`None | Suppressed | Claimed | Filtered`)
so every surface *reads* which state applies instead of guessing. Where nothing
can hide, `--dry-run` prints that fact every run.

`keyboard_count()` (`ksx-platform/src/winusb.rs:673-675`) **stays counting
keyboards only** — widening the last-keyboard lockout guard to "input devices"
would refuse the first gamepad on a laptop for no reason.

**Retire the 8 movement/wheel mouse pseudo-keys in the open** — they are digital
directions for analog controls, which is why they have sat unwired. Wire the 5
buttons; route movement and wheel through `SourceControl::Hid`.

### M15–M18

- **M15** adds `extras`, the aux vocabulary (`touchpad`, `share`, `capture`,
  `mic`, `paddle.l1|r1|l2|r2`, `tx`/`ty`, `gx`/`gy`/`gz`, `ax`/`ay`/`az` — all
  one dot, no grammar change), the capability model, and protocol v2 as a
  **`SubmitEx` sibling** so the 24-byte `Submit` and all twelve golden frames
  stay byte-identical. A capability mismatch on a `[bindings]` row is
  **always a warning, never an error** — otherwise re-persona-ing a slot would
  require editing its preset, which `persona.rs:3-7` forbids.
- **M16** forks the SDK as **patches over the pinned upstream commit**
  (`2a0dac08…`), adding only `RawTail` placement; the vendor-blob bytes are
  computed in **Rust**, beside the existing contracts and vectors, so the fork
  never learns a device format. The `228` count pin becomes a **catalog
  manifest pin** (strictly stronger — it catches a swapped profile a count
  cannot). CI re-derives the fork from verified upstream + patches.
- **M17** widens `Feedback` with the original three fields **first** and
  `Default` neutral, so the SSE JSON is byte-identical when nothing new is
  present. The C# host forwards raw output-report bytes; **decode stays in
  Rust** where the 16 golden vectors are. `Motors::as_u8()` stays; add
  `into_feedback()` so the already-decoded impulse-trigger magnitudes stop
  being discarded.
- **M18** exposes catalog personas — each needs its own hardware leg, because
  a persona is a promise the Studio makes to a player. Plus the two queued MAME
  items: `ksx export mame-ctrlr` (ksx is uniquely able to pin joystick
  numbering, because it knows its own pad order) and the `arcade-6button`
  button-6 loss (panel button 6 → `Trigger::Right` → an analog axis with no
  numbered button; six-button fighters lose heavy kick today, silently).

---

## 4. Cross-cutting rules

- **Every stage carries the standing gate:** `cargo fmt --all --check`,
  `cargo clippy --workspace --exclude vigem-client --all-targets -- -D warnings`,
  `cargo test --workspace --exclude vigem-client`, and **all four feature
  combinations** for `ksx-app` and `ksx-backend` (none / studio / cabinet /
  studio+cabinet) — five breakages have reached main through that gap. Push the
  branch and let CI gate it.
- **Two adversarial reviewers per implementation** (correctness against typed
  contracts; crash/hang/recovery safety) per `docs/PLAYBOOK.md`.
- **Build order is backend verb → CLI → the surface a human performs it on.**
- **A lane flips its gate only after its device is observed**, and a lane that
  fails reverts the flip with the exact error recorded in
  `docs/HIDMAESTRO-STATE.md`.
- **Hot path stays allocation-free**; transforms run on the engine thread and
  must be deterministic and replayable.
- **This doc must stay cited from the code it governs** —
  `crates/ksx-app/tests/docs.rs` fails when a governing doc loses its last
  citation.

---

## 5. Verification

Per milestone, before any hardware leg:

```
cargo fmt --all --check
cargo clippy --workspace --exclude vigem-client --all-targets -- -D warnings
cargo test --workspace --exclude vigem-client
cd studio-ui && node build.mjs     # twice; assets byte-identical
cd studio-ui/pwtest && npm test
```

**The three regression assets that make this plan safe:**

1. **The replay digest** (`crates/ksx-app/tests/replay.rs`, `SESSION_DIGEST`)
   must stay unmoved through M11 and M13 — that is the proof the type
   substitutions changed no behaviour. Extend the `--record` corpus additively
   (field 4 parses as `bool`, else `i16`) and **record published pad states
   alongside inputs**, making it a two-sided regression. Cheap now, expensive
   to retrofit.
2. **`crates/ksx-core/tests/engine_analog_alloc.rs`** — a copy of
   `engine_alloc.rs`'s shape (one `#[test]` per binary, because the allocation
   counter is process-global) driving a stick, a mouse and a ladder. Zero
   allocations after warmup.
3. **Cross-machine digest equality** — the analog corpus must produce identical
   digests on the CI runner and on the cabinet. This is why every transform is
   integer.

**Hardware legs** (supervised, `docs/GATES.md` shape): M12 intermediate stick
travel in joy.cpl · M14 a DS4 and the panel both driving slot 1, then the same
DS4 claimed and absent from joy.cpl · M16 gyro in a Switch emulator and
touchpad XY in a PS5-era title · M17 rumble from a game reaching a cabinet LED ·
M18 a joy.cpl press-check per newly exposed persona · M19 keystrokes landing in
both Notepad and MAME.

---

## 6. M19 — output to keyboards, not just pads

Victor: *"output to not just controllers but also keyboards if wanted to so
people can use this app for macros etc."*

This is enhancement **E3** (`docs/ENHANCEMENTS.md:129-144`) and it is also the
second-highest item in the transform catalogue
(`docs/INPUT-TRANSFORMS.md:660-664`): *"A cabinet needs Escape-to-exit, F1
menus, coin insert, save-state, volume. Today ksx can only produce pad state,
so admin actions have no home. This is arguably more urgent than macros: it is
what makes the panel self-sufficient."*

**What already exists:** `ksx_platform::inject::KeyInjector::stroke(Key, bool)`
(`crates/ksx-platform/src/inject.rs:221-224`) — built for WinUSB passthrough
re-injection, which is a keyboard output path that already ships and is already
gated.

**The three hard parts, in order:**

1. **A second output kind.** `E1.1` states the principle to follow
   (`docs/ENHANCEMENTS.md:103-105`): *"gamepads keep `PadState`, while
   keyboard/mouse output use **typed device-specific states** rather than
   pretending every USB device is a pad."* So a slot's output becomes a
   **target list**, not a single pad, and `Binding` gains a key-output variant
   whose spelling must not collide with the pad vocabulary
   (recommend `key.<name>`, e.g. `key.Escape`).
2. **`SendInput` does not reach MAME.** Measured, not theoretical
   (`INPUT-TOPOLOGY-AND-ANTICHEAT.md:344-354`): MAME's Raw Input path drops
   events with a null `hDevice`. So a synthetic-keystroke path built on
   `SendInput` alone will work in Notepad and in most games and **fail in the
   one application an arcade cabinet exists for**. The acceptance target above
   names both destinations deliberately. Options to price when M19 starts:
   `-keyboardprovider win32`/`dinput` as a documented requirement (cheap,
   honest, user-visible), or a virtual keyboard **device** so the keystrokes
   have a real `hDevice` — which is exactly what M8.1's VIIPER lane is for
   (`docs/ENHANCEMENTS.md:34-38`, `:92-108`). VIIPER's GPL-3.0 core must stay
   across a process boundary pending a licensing review.
3. **Every exit path must release every held key.** A stuck modifier from a
   crashed session is worse than a stuck pad button, because it makes the
   machine unusable rather than the game. Mirror `engine_toggle.rs`'s four
   exits: session stop / escape, device yank, hot swap, reset.

**Do not** implement this as "gamepad → keystrokes" in the sense already
rejected (`INPUT-TOPOLOGY-AND-ANTICHEAT.md:585-588`). That rejection was about
using key synthesis as a *substitute* for reading pads — round-tripping analog
through digital and losing it. A first-class key-output target chosen by the
user is a different feature and is wanted.

---

## 7. What is already done (2026-08-21)

**M11 piece 3 — `DeviceId(Arc<str>)` — landed.**
`crates/ksx-core/src/device.rs`. The whole workspace compiled with **no other
change**, which is the proof the abstraction was clean. New test
`cloning_a_device_id_shares_the_string_instead_of_copying_it` pins the
property. `cargo test -p ksx-core` green (240 tests).

**M11 piece 2 — `PadControl` + the resolver — landed.**
New `crates/ksx-core/src/control.rs` (`PadControl`, `PadControl::of`,
`is_analog`); `SlotRuntime::resolve` replaces `opposite_snap`, which is
**deleted**; `press` and `release` are now two thin callers of that one
function. `endpoint_keys` is re-keyed `HashMap<PadControl, …>` and carries
**digital endpoints only** — `axis_entries` was already the analog holder
table, and merging them would have broken the toggle/turbo rewiring, whose
`keys.retain` drops a holder from an endpoint *wholesale* (right for a button,
wrong for a key driving two values on one axis).

Measured, not asserted:

- `cargo test -p ksx-core`: **308 passed, 0 failed**, with **no existing test
  edited**. `socd_model_holds` re-run at `PROPTEST_CASES=20000`.
- The new tests were run against the **pre-change** engine and fail there, so
  they pin the fix rather than merely passing beside it.
  `same_sign_ladder_release_falls_back_instead_of_centering` fails with
  `left: 0` where `16384` was still held — that is the bug itself.
  `a_weaker_same_sign_press_does_not_stomp_a_stronger_hold` fails one
  assertion earlier, on the boolean `assert!(d.is_empty(), …)`, because the old
  `press` was a blind `*axis_field = value` and so emitted a delta; expect that
  message, not a `left`/`right` pair, when reproducing.
- The rule this document *originally* stated was installed and measured to
  fail, which is why §2 now carries an amendment. See that ⚠️ block.

**One defect this change introduced and adversarial review caught**, before it
was committed. The first cut bucketed a demand by `value >= 0`, which made
`lx.0` — an authorable binding whose entire meaning is "centre this axis" — a
*positive* holder of magnitude 0. It then lost `max()` to any held positive
holder while still beating every negative one, so the same binding centred a
left lean and did nothing to a right one. Measured: with `lx.max` held,
pressing `lx.0` left the axis at `32767` where the pre-change engine set it to
`0`. The fix makes zero a **sign of its own** (`axis_sign_last: [i8; 4]`,
`-1`/`0`/`+1`), and
`a_zero_axis_demand_centres_whichever_way_the_stick_leans` pins the symmetry.
The lesson is worth keeping: a green suite is evidence, not proof — no existing
test bound `lx.0` at all.

**Two deliberate semantic widenings**, neither reachable by any shipped
template or built-in preset (both need a hand-authored custom value like
`lx.16000`), and both are the ladder semantics M12 needs:

1. A weaker **same-sign** press no longer stomps a stronger held one.
2. Releasing a `value == 0` axis holder while an opposite-sign holder is held
   now falls back instead of centring (`opposite_snap`'s sign filter returned
   `None` for a released 0).

M11's "no user-visible change" acceptance therefore holds for every shipped
configuration, but not for arbitrary hand-authored ones. Comments in four test
files that named the deleted function were re-worded; no assertion was touched.

**M11 piece 1 — the fixed arrays are gone.**
`ksx_core::preset::{MAPPABLE_COUNT, mappable_functions}` is the one vocabulary,
derived from the four rosters by const evaluation, so an endpoint added to
`XButton::ALL` (or `Trigger`/`Axis`/`DpadDirection`) changes every count by
existing. `Preset::builtin_empty` is now a `map` over it. `ZONE_XBOX`/
`ZONE_DS4` are `&[Zone]`, `zones_for` returns `&'static [Zone]`, and the
`FUNCTIONS: [&str; 25]` and `MACRO_COLUMN_COUNT = 37` literals are **deleted** —
the grid's width is now `non_direction_zones + mechanisms × RING.len()`.

The two crates never became coupled: ksx-studio still links only `ksx-api` at
runtime, and every derivation above happens in `#[cfg(test)]` through the
existing dev-dependencies.

*Measured:* `cargo test --workspace --exclude vigem-client` **2456 passed, 0
failed**; both insta snapshots byte-identical with **zero `.snap.new`**; no
`studio-ui/` file and no built asset touched.

*The restated `the_grid_is_three_rings` was mutation-tested, and the results
changed the design:*

- Asserting the ring's token against `Mechanism::function` is a **tautology** —
  `macro_columns` builds the token with that very call. Swapping two of its arms
  left both the restated test **and the literal-glyph one it replaced** green.
  The cardinal claim now routes through `ksx_core::socd::pointing`, "the one
  function" for where a binding points — an independent path, and the mutation
  now fails with *"LeftStick position 2 draws ← but lx.max points elsewhere"*.
  This is a capability neither the old test nor the plan had.
- Restating the band list as a property **weakened** it: a run-derived
  comparison cannot catch a reordered band, which the old literal could. Band
  order is a design decision that does **not** grow with the vocabulary, so the
  literal is kept alongside the derived checks. Verified by mutation.
- One assertion remains structurally circular (the grid's mechanism order
  against the zone table's, because `macro_columns` derives band order from
  that table). Not a regression — the old test could not see it either — but it
  is not load-bearing and should not be trusted as such.

**Deferred, deliberately: the generated `zones.gen.ts` (M11 piece 1b).**
The vocabulary is hand-mirrored in `MapIsland.ts` (`ZONE_XBOX`, `ZONE_DS4`) and
`MapPage.ts` (`FUNCTIONS`, the no-JS `<select>`). Generating it would force a
`node build.mjs` and a commit of `crates/ksx-studio/assets/**`, which CI
byte-diffs — and a concurrent branch was rewriting exactly those assets, so the
conflict was guaranteed on files that must not be hand-merged. The generator
also runs the wrong way today: the `tokens.gen.css` precedent is TS → Rust,
while this needs Rust → TS plus new `ci.yml` path registrations.

Shipped instead at zero collision cost:
`the_typescript_mirrors_carry_the_same_vocabulary` `include_str!`s both files
and pins them against `mappable_functions()`. That captures the *whole* value of
generation — drift is caught — without touching a shared file. Verified by
mutation: dropping one entry fails with `24` vs `25`. When the art branch lands,
1b replaces the pin with real generation.

**Not yet started:** M11 piece 4, piece 1b, and everything from M12 on.

### Recommended pickup order for a fresh agent

1. **M11 piece 1b** — the generated `zones.gen.ts`, once the studio-ui art
   branch has merged. Shape: a Rust test emits/verifies
   `studio-ui/tokens/zones.json`, `build.mjs` reads it beside the existing token
   writes and emits `src/zones.gen.ts`, and both paths are registered in
   `ci.yml`. Delete the drift pin in the same commit that replaces it.
2. **M11 piece 4** (`SdkStateMapper.Axis()`) — C#, needs new golden vectors and
   a hardware leg to confirm intermediate stick travel.
3. Then M12. Its **axis** ladders and curve tables are the first thing to
   exercise the resolver's magnitude clause with values other than ±32767 —
   note that `Binding::Pressure` is **not**, because it drives a trigger and
   `PadControl::is_analog` reports triggers as digital (ksx drives `lt`/`rt` to
   `u8::MAX` or `0` and nothing between). Making trigger travel real is a
   change to `is_analog` and to the resolver's digital arm, and M12 must decide
   that deliberately rather than inherit it.

### Branch and state at handoff

Branch `codex/universal-io`, based on `codex/ds4-hybrid-controller-art`
@`9cf3f49` (which already contains `codex/studio-nocturne-workspace`). Unpushed.
Victor pushes on request only.
