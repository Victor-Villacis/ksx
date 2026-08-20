# S1.5e Actions-only artifact observation

This leaf is the first, deliberately non-authoritative build observation for the
S1.5d HIDMaestro managed candidate. It authorizes one bounded GitHub Actions job
to compile the source candidate twice in isolated temporary roots and inspect
the resulting DLL, PDB, and dependency manifest as inert bytes. It does not
authorize a local build, load the candidate into a CLR, execute candidate code,
install or contact a driver, touch a device, publish an artifact, or retain the
build output.

The observation stages exactly 244 input files into each quiescent, hash-bound
build root. Workspace-authored source-candidate text is identity-checked by its
normalized lock and staged as deterministic UTF-8/LF bytes; the retained
Windows-checkout source and all profiles preserve their observed raw upstream
bytes after their raw/canonical checks:

- 15 source-candidate files, including the project and `.gitignore`;
- the one retained upstream `HMOutputPacket.cs` at the fixed project staging
  path; and
- 228 profile JSON resources selected by `profiles/catalog.lock.json`.

The upstream profile contract preserves an existing UTF-8 BOM while replacing
CRLF with LF and rejecting bare CR. At pinned commit `2a0dac0`, the exact
selected BOM set contains only `profiles/nintendo/switch-pro.json`; the runner
checks that one-path set before staging and preserves its raw bytes.

The runner rejects extra files, reparse points, submodules, changed raw bytes,
changed normalized bytes, generated compiler sources, unexpected evaluated
items, packages, any effective compiler analyzer, generated C# output,
response-file injection, and nondeterministic A/B DLL, PDB, or deps output. The
selected 229 upstream files and both staged trees are checked both before and
after the builds with framed raw tree hashes. The roots are called quiescent and
hash-bound—not immutable—because Windows filesystem permissions do not prove
immutability.

The two candidate builds use separate candidate, object, output, package, and
child-process TEMP roots. The pinned SDK installation and a hardened CLI home
may be shared; the proof therefore claims isolated build state, not an isolated
SDK installation. An environment-root `global.json` selects SDK `10.0.400`
before the runner's first `dotnet --version` call.

The binding binary-composition authority is the official .NET 10
`releases.json` entry for the August 11, 2026 SDK `10.0.400` win-x64 archive,
its exact SHA-512 and byte length, and the installed SDK's exact `.version`,
`.toolsetversion`, `Microsoft.NETCoreSdk.BundledVersions.props`, and pack-tree
identities. The `.version` file binds that released archive to the public
`dotnet/dotnet` VMR commit
`14fbf8d5271c98133561eb55185fdb05b286f578`. At that exact commit,
`src/sdk/eng/Version.Details.xml` pins the compile-time
`Microsoft.NETCore.App.Ref` pack to `10.0.11`, while
`src/sdk/eng/ManualVersions.props` pins the Windows projection pack to
`Microsoft.Windows.SDK.NET.Ref` `10.0.26100.57`. The exact source files are
hash-pinned too. The compile-time core pack and inspector host runtime are both
version `10.0.11`, but remain independently identified inputs.

The runner verifies the released SDK evidence files and exact installed
348-file, 43,511,590-byte core reference-pack tree, then pre/post binds them. It
performs one finite, no-proxy/no-redirect infrastructure fetch of the exact
13,193,759-byte Windows pack, checks both pinned package hashes, safely expands
the exact 97-file archive, and preserves that original tree as evidence. It
then makes an observation-only targeting-pack copy. In that derived copy only,
it securely parses each pack's `data/FrameworkList.xml`, removes every exact
`Type="Analyzer"` row and only the payload named by that row, and binds the
derived tree before and after all builds. This removes six core generators and
the pinned `WinRT.SourceGenerator.dll`; reference assemblies and the exact
`net10.0-windows10.0.26100.0` candidate TFM are retained. Candidate restore and
build have empty package sources, all targeting-pack download fallbacks are
disabled, the MSBuild workload resolver is disabled in both the sealed child
environment and global properties, and no candidate network access is authorized.
The receipt reports that configuration and authority boundary; the runner does
not instrument operating-system sockets and therefore does not claim a measured
zero-network fact for the SDK processes.

The combined derived overlay is independently pinned at 438 files,
108,699,170 bytes, and one framed raw-tree SHA-256. The receipt exposes the
actual original and sanitized file counts, byte lengths, FrameworkList hashes
and lengths, exact removed-analyzer path/hash inventory, SDK evidence hashes,
and pre/post overlay identities without exposing host filesystem paths.

After restore and before each candidate or inspector `CoreCompile`, the runner
resolves references and requires the effective `@(Analyzer)` item set to be
empty. Each C# compilation enables logical command-line capture, whose captured
arguments must contain no analyzer, analyzer-config, additional-file, or
explicit response-file argument. Editor/global-config discovery is disabled;
the effective editor-config, analyzer-config, additional-file, and compiler
response-file item sets must all be empty. `NoConfig=true` separately rejects
ambient compiler response files. This does not claim to observe an internal
compiler-server transport mechanism. The empty compiler-extension closure is
re-evaluated after all three builds, and every compiler-generator output root
must remain empty. Analyzer-disable switches are defense in depth only; they are
not treated as proof that source generators did not execute.

`inspector/HIDMaestro.ArtifactInspector.csproj` has no package, project, or
assembly references. It explicitly compiles only `Program.cs` and the
hash-pinned, linked `tools/hidmaestro-probe/ManagedPeReader.cs`. The inspector
pins `Microsoft.NETCore.App` runtime `10.0.11`, and host roll-forward remains
disabled. Before launch, `dotnet --list-runtimes` must report that exact runtime
once beneath the resolved .NET root; its file set and raw tree are bound before
and after inspection, while the receipt redacts the filesystem path. The inspector
opens the candidate with `FileShare.Read`, parses it with `PEReader` and
`MetadataReader`, and never asks the CLR to load, initialize, instantiate, or
execute the target. It inventories the complete public surface, metadata tables,
assembly/type/member/method-spec references, method bodies and every IL metadata
token operand, resources, native imports, portable PDB documents, evaluated
compiler inputs, reference packs, assets, and deps data.

For this fixed Amd64 Roslyn/.NET 10 build, the managed PE writer emits no legacy
native CLR startup stub. The observer therefore requires the PE
`AddressOfEntryPoint == 0`; empty import, import-address, and base-relocation
directories; and zero native import modules and symbols. It separately requires
the CLR header's `EntryPointTokenOrRelativeVirtualAddress == 0` with
`NativeEntryPoint` clear. The TLS, delay-import, and export directories must also
be empty. These byte-only checks do not load or execute the candidate.

This commit contains observation infrastructure only. No Actions observation is
established until the job succeeds. Post-build DLL/PDB/deps hashes, MVID, exact
AssemblyRef/TypeRef/MemberRef/MethodSpec inventories, PDB identity, and raw
resource-catalog digest are intentionally unresolved here. A later reviewed
commit may freeze those observed values. All six aggregate artifact/runtime/
driver/distribution gates remain false.

## GitHub Actions handoff

After the aggregate contracts have been reconciled to authorize this bounded
Actions observation, invoke the leaf on a Windows runner with the repository as
the current workspace:

```powershell
pwsh -NoProfile -File tools/hidmaestro-runtime-candidate/s1_5e/verify-source-contract.ps1 -WorkspaceRoot $PWD
pwsh -NoProfile -File tools/hidmaestro-runtime-candidate/s1_5e/run-actions-proof.ps1 -WorkspaceRoot $PWD
```

The proof script requires GitHub Actions environment markers and the pinned
.NET SDK. It emits exactly one JSON receipt on the success stream, deletes all
temporary source, staging, object, output, inspector, package, and report roots,
and never copies the candidate artifacts back into the workspace. Preserve only
the JSON receipt for review; do not upload the DLL or PDB.
