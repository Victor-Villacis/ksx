# HIDMaestro v1.6.1 profile-source lock

This directory freezes the complete `profiles/**` source tree at upstream tag
`v1.6.1`, commit `2a0dac0857901a63d365a36dcf99cf50114ca954`.
It contains no upstream profile payloads. `catalog.lock.json` records the
repository-relative path, canonical byte length, SHA-256, profile ID,
deployability result and decoded descriptor hash for every source file.

The source tree contains 231 JSON files in 32 vendor directories. The pinned
`HIDMaestro.Core.csproj` explicitly excludes three root data files:

- `profiles/schema.json`
- `profiles/scraped_descriptors.json`
- `profiles/linux-kernel-fixed-descriptors.json`

That leaves 228 intended embedded profile inputs. Exactly 130 have a non-empty
descriptor string whose whitespace-stripped form is valid even-length
hexadecimal. This check does not prove semantic HID descriptor validity. There
are no duplicate profile IDs. Those source facts independently explain the
official release DLL probe's 228-resource and 130-deployable counts.

They do **not** yet bind the source catalog byte-for-byte to the release DLL.
The release catalog digest
`8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A`
is framed over actual CLR manifest-resource names and exact embedded bytes.
This lock instead frames canonical source bytes with repository paths. Source
inspection sees the MSBuild logical-name template, but does not evaluate
MSBuild metadata or inspect the release PE resource table, and checkout EOL
conversion can change embedded bytes. Matching counts are not proof of raw
resource identity. The manifest therefore records that binding as unresolved.

## Read-only verification

Given a checkout of the pinned upstream source, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  tools/hidmaestro-runtime-candidate/profiles/verify-profile-catalog.ps1 `
  -SourceRoot C:\path\to\HIDMaestro
```

The verifier reads files, parses JSON and hashes bytes. It does not invoke Git,
MSBuild, .NET build tools or any upstream executable; it never loads an
upstream assembly and performs no writes. It accepts LF or CRLF checkouts by
canonicalizing CRLF to LF before hashing, preserves an existing UTF-8 BOM and
rejects invalid UTF-8 or bare carriage returns. It emits exactly one JSON
document and exits nonzero on drift.

Passing this verifier proves the source inventory, exact file contents,
selection rule, descriptor string syntax/shape and the two source-path-framed
digests. It does not prove semantic HID descriptor validity or authorize
building, loading, executing, distributing or enabling a HIDMaestro runtime.
