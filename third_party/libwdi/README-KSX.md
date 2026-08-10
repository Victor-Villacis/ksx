# libwdi prepare provider for KSX

This directory contains the complete corresponding source for the replaceable
`libwdi.dll` that KSX distributes. It is based on upstream libwdi 1.5.1 at
commit `9b23b82a2dd1cbffc16d46c212f92c6bf8c0c602`.

Upstream: <https://github.com/pbatard/libwdi>

License: GNU Lesser General Public License, version 3 or (at your option) any
later version. `COPYING-LGPL` is the LGPL text and `COPYING` is the GPL text it
incorporates. The DLL is dynamically loaded and may be replaced with a
compatible modified build.

This provider is an **installed-only recovery component**, not a portable or
developer command path. The installer places `libwdi.dll` beside the fixed
GUI-subsystem `ksx-winusb-helper.exe` and installs this complete corresponding
source under `THIRD-PARTY-SOURCE\libwdi`. The elevated helper accepts only that
canonical Program Files sibling after live owner/DACL/reparse checks. The
portable ZIP omits helper, DLL and corresponding source together and therefore
cannot perform the supported built-in prepare/release flow.

Studio never loads this DLL and never sends a provider path across UAC. It
sends a typed exact-device request to the installed helper only after the user
confirms a tested spare keyboard, the selected keyboard's rebind consequence,
and the machine-local certificate. Rust owns device resolution, receipt
journaling, package install/removal, exact post-survey and rollback; this DLL
only prepares the signed package.

## KSX build

From a normal PowerShell prompt with Visual Studio Build Tools installed:

```powershell
third_party/libwdi/build.ps1 -OutputDirectory target/libwdi-release
```

The script finds MSBuild with `vswhere`, builds only the x64 Release DLL, and
writes `libwdi.dll` to the requested directory. GitHub Actions builds it twice
into different directories and rejects differing SHA-256 hashes before either
distribution is assembled.

The project pins Windows SDK `10.0.19041.0`. The release workflow pins the
`windows-2022` runner, MSVC tools `14.44.35207`, and toolset family `v143`;
`-VCToolsVersion` remains optional for a contributor's local diagnostic build.
`/Brepro`, a static CRT, and no debug data make the DLL byte-identical across
independent output and source paths.

The checked-in `src/embedded.h` contains the canonical WinUSB template and no
binary payload. The KSX caller writes the byte-identical
`src/winusb.inf.in` template into its protected transaction directory and
passes it with `external_inf=TRUE`; the provider exact-compares and tokenizes
that same opened file. The prepared INF is the catalog's one and only member,
with a SHA-256 member digest. No WDK redistributable, coinstaller,
installer helper, libusb driver, Zadig executable, or network downloader is
embedded or built.

## Deliberately narrow ABI

`src/libwdi.def` exports only:

- `wdi_is_driver_supported`
- `wdi_prepare_driver`
- `wdi_strerror`

KSX enumerates the exact device itself and installs or removes the resulting
package with Windows `pnputil`. The provider cannot enumerate devices or
install a driver. `wdi_prepare_driver` rejects every mode except elevated,
external-INF, signed-catalog, in-box WinUSB preparation.

## Security changes from upstream

The source in this directory is modified, rather than a prebuilt upstream DLL.
The relevant changes are intentionally kept beside the build:

- Windows 10/11 x64 and in-box WinUSB only; no WDK/coinstaller payload.
- A canonical, existing, non-reparse, Rust-ACL-verified output directory; the
  provider never creates it, changes its owner, or opens a template elsewhere.
- Exact canonical-template comparison plus fixed description, manufacturer,
  interface GUID, filename grammar, and deterministic DriverVer tokens.
- A fresh 128-bit random machine key-container name per preparation.
- A pinned `MS_ENH_RSA_AES_PROV`/`PROV_RSA_AES` provider and fixed
  `KSX-libwdi-` ownership prefix for independent residue recovery.
- A 4096-bit non-exportable signing key and SHA-256 signature.
- Catalog **member** digests are upstream's SHA-1, in an upstream version-1
  catalog. This is deliberately *not* modernised, and the reason is recorded
  because it looks like an oversight: a SHA-256 member digest was written into
  a catalog that still declared SHA-1 (`CryptCATOpen` with `dwPublicVersion`
  0, OID `1.3.6.1.4.1.311.12.1.2`), so Windows hashed the INF with the
  algorithm the catalog claimed, matched no member, and refused the package
  with `ERROR_FILE_HASH_NOT_IN_CATALOG` (`0xE000024B`). That reads as
  unsigned, which raises a prompt, which is why `pnputil /add-driver` blocked
  indefinitely on a machine with nobody at it. Declaring version 2 so both
  sides said SHA-256 was then tried, and Windows still refused it. What ships
  is upstream's construction — the one Zadig uses and Windows 10/11 accepts.
  **If you modernise this, both sides move together, and only a real
  `/add-driver` proves it.** The *signature* is unaffected: still a 4096-bit
  key and SHA-256.

  The references, so this does not have to be re-derived:
  [`CryptCATOpen`](https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatopen)
  and [Catalog Files](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/catalog-files)
  give the mapping — catalog version 1 is SHA-1, version 2 is SHA-256.
  Microsoft's [driver-staging walkthrough](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/dd919234\(v=ws.10\))
  reproduces this failure deliberately, as its Step 2: a package whose hashes
  no longer match its catalog raises the **Windows Security** dialog "warning
  you that Windows cannot verify the publisher". Windows cannot tell an
  algorithm disagreement from a tampered file, and an unattended machine cannot
  answer that dialog — which is why the symptom was a hang and not an error.
  Its Step 3 is the shape to aim for: matching thumbprints stage "with no
  prompts". Note also that
  [`CryptCATAdminCalcHashFromFileHandle` returns an Authenticode hash, not a
  flat file hash](https://learn.microsoft.com/en-us/answers/questions/596496/makecat-sha256-in-windows-is-different-than-expect),
  so a `Get-FileHash` comparison agreeing is not by itself proof that a
  modernised catalog is right.

  `test-provider.ps1` now throws on this disagreement, by name, before reaching
  the step that would otherwise just stop responding.
- Certificate validity relative to the transaction time, not a fixed date.
- The catalog is signed while the certificate is still untrusted.
- The private-key container is deleted and absence is verified before the
  public certificate can enter Root or TrustedPublisher.
- Key deletion failure is fatal. Any partial trust-store change is rolled back
  by exact DER equality, never by a broad subject-name deletion.
- The caller supplies a cryptographically unique certificate subject, then
  independently verifies identical DER, thumbprint, and no private key in both
  stores before installing the package.

`test-provider.ps1` is an elevated smoke test for a disposable Windows CI
runner. It prepares a catalog for a synthetic device, verifies the exact
certificate, catalog, property, provider-container, and relative-validity
postconditions, and uses `pnputil /add-driver` (without `/install`) to prove
that Windows accepts the signed package. Its `finally` block deletes that exact
published package, rescans and proves it absent, then restores both certificate
stores, the key provider, and the work directory. It is intentionally never run
on a developer or QA workstation.

**Release status:** the pinned clean-runner build/reproducibility/smoke job is
defined but is **NOT RUN** for the current 0.2.0 candidate until GitHub Actions
records it against that exact commit. A local diagnostic build or DLL hash is
not release evidence, and this file does not claim the package has shipped or
passed physical Gate 4.
