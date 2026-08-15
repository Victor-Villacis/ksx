# S1.5e Actions-only artifact observation

This leaf is the first, deliberately non-authoritative build observation for the
S1.5d HIDMaestro managed candidate. It authorizes one bounded GitHub Actions job
to compile the source candidate twice in isolated temporary roots and inspect
the resulting DLL, PDB, and dependency manifest as inert bytes. It does not
authorize a local build, load the candidate into a CLR, execute candidate code,
install or contact a driver, touch a device, publish an artifact, or retain the
build output.

The observation stages exactly 241 input files into each quiescent, hash-bound
build root. Workspace-authored source-candidate text is identity-checked by its
normalized lock and staged as deterministic UTF-8/LF bytes; the retained
Windows-checkout source and all profiles preserve their observed raw upstream
bytes after their raw/canonical checks:

- 12 source-candidate files, including the project and `.gitignore`;
- the one retained upstream `HMOutputPacket.cs` at the fixed project staging
  path; and
- 228 profile JSON resources selected by `profiles/catalog.lock.json`.

The upstream profile contract preserves an existing UTF-8 BOM while replacing
CRLF with LF and rejecting bare CR. At pinned commit `2a0dac0`, the exact
selected BOM set contains only `profiles/nintendo/switch-pro.json`; the runner
checks that one-path set before staging and preserves its raw bytes.

The runner rejects extra files, reparse points, submodules, changed raw bytes,
changed normalized bytes, generated compiler sources, unexpected evaluated
items, packages, analyzers outside the pinned .NET root, generated C# output,
response-file injection, and nondeterministic A/B DLL, PDB, or deps output. SDK
analyzers are exhaustively role/hash inventoried but are not allowlisted until
pass 2. The selected 229 upstream files and both staged trees are checked both before and
after the builds with framed raw tree hashes. The roots are called quiescent and hash-bound—not immutable—because Windows filesystem permissions do not prove
immutability.

The two candidate builds use separate candidate, object, output, package, and
child-process TEMP roots. The pinned SDK installation and a hardened CLI home
may be shared; the proof therefore claims isolated build state, not an isolated
SDK installation. An environment-root `global.json` selects SDK `10.0.400`
before the runner's first `dotnet --version` call.

`inspector/HIDMaestro.ArtifactInspector.csproj` has no package, project, or
assembly references. It explicitly compiles only `Program.cs` and the
hash-pinned, linked `tools/hidmaestro-probe/ManagedPeReader.cs`. The inspector
pins `Microsoft.NETCore.App` runtime `10.0.11`, and host roll-forward remains
disabled. The inspector
opens the candidate with `FileShare.Read`, parses it with `PEReader` and
`MetadataReader`, and never asks the CLR to load, initialize, instantiate, or
execute the target. It inventories the complete public surface, metadata tables,
assembly/type/member/method-spec references, method bodies and every IL metadata
token operand, resources, native imports, portable PDB documents, evaluated
compiler inputs, reference packs, assets, and deps data.

A normal x64 managed DLL may have a nonzero PE `AddressOfEntryPoint` for the
native `mscoree.dll!_CorDllMain` bootstrap. The contractual managed-entry-point
check is instead the CLR header's `EntryPointTokenOrRelativeVirtualAddress == 0`
with `NativeEntryPoint` clear. The native bootstrap is reported and constrained;
the import table must contain only `mscoree.dll!_CorDllMain`, the TLS directory
must be empty, and the native entry-point address must be present. This first
observer does not interpret the entry-point machine-code trampoline or prove its
IAT target, so it is not confused with managed candidate execution.

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
