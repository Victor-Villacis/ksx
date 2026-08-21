# Third-party license material

`NOTICE` at the repository root maps each copied, vendored, embedded, or
bundled component to the KSX files that contain it. This directory carries the
corresponding full license texts.

- `Gamepad-Asset-Pack-MIT.txt` covers the controller drawings used by Studio.
- `dualshock-tools-MIT.txt` covers the semantic DualShock 4 geometry used by
  the Nocturne canvas.
- `CC0-1.0.txt` is the canonical Creative Commons CC0 1.0 Universal legal code
  governing the Funky Designs UK controller artwork used in Nocturne's hybrid
  DualShock 4 drawing.
- `Funky-Designs-CC0-1.0-Dedication.pdf` is the exact 2026-08-21 dedication
  supplied by the project owner. It names Funky Designs UK as dedicator and
  expressly includes artwork depicting the PS4 DualShock; `NOTICE` records its
  SHA-256 and the hashes of the selected source archive and SVG entry.
- `Lucide-ISC.txt` covers the `gamepad-2` geometry used in the detailed KSX
  mark and its generated images/icons.
- `vigem-client-MIT.txt` covers the vendored Rust ViGEm client.
- `ViGEmBus-BSD-3-Clause.txt` covers the bundled ViGEmBus 1.22.0 installer.
- `HIDMaestro.txt` covers the pinned HIDMaestro v1.6.1 material used by the
  runtime host and the optional exact-hash upstream download invoked by setup.
  KSX ships the license and pin-aware bootstrap, not the upstream SDK binaries.
- `Forma-MIT.txt` covers the Forma runtime embedded in Studio and the Forma
  Rust crates linked into `ksx.exe`.
- `alien-signals-MIT.txt` covers the signal engine bundled through
  `@getforma/core` into Studio's generated JavaScript.
- `libwdi-LGPL-3.0-or-later.txt` covers the dynamically loaded, modified
  prepare-only `libwdi.dll`; `GPL-3.0.txt` is the GPL text incorporated by
  LGPL version 3. Complete corresponding source and build instructions ship at
  `THIRD-PARTY-SOURCE/libwdi/` in the installed distribution. The portable ZIP
  omits the helper, provider, and source together.
- `Rust-dependencies.html` and `Rust-dependencies-winusb-helper.html` list every
  Rust crate in the two locked Windows release dependency graphs, their
  versions and repositories, and the full license text selected for each
  crate. The application report explicitly includes `interception-sys`
  (LGPL-3.0), `kanata-interception`, Forma, and `vigem-client`.

The Rust report is generated from `Cargo.lock`, `about.toml`, and `about.hbs`:

```powershell
cargo about generate --locked `
  --manifest-path crates/ksx-app/Cargo.toml `
  --features "studio cabinet" `
  --target x86_64-pc-windows-msvc `
  --fail `
  --output-file THIRD-PARTY-LICENSES/Rust-dependencies.html `
  about.hbs

cargo about generate --locked `
  --manifest-path crates/ksx-winusb-helper/Cargo.toml `
  --target x86_64-pc-windows-msvc `
  --fail `
  --output-file THIRD-PARTY-LICENSES/Rust-dependencies-winusb-helper.html `
  about.hbs
```

`Cargo.lock` pins package identities, versions, sources, and checksums. It does
not contain license texts; the generated report is the distributable license
material for the Rust dependency graph.
