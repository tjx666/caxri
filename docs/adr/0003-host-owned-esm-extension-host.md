---
kind: adr
status: accepted
---

# Host-owned native ESM Extension Host

- Date: 2026-08-22
- Refs: [#292](https://github.com/tjx666/caxri/issues/292)
- Amended by: ADR 0004 (target, pending)

Caxri uses one shared, Host-owned Node Extension Host for declarative ViewContainer, View, and
Command contributions. The Host is the sole catalog, supervision, grant, and Runtime-projection
authority. The child owns extension JavaScript objects and providers but never SQLite, Projects,
Sessions, PTYs, Desktop IPC, or React components.

Extensions are native ESM. The physical workspace package named `caxri` is ESM-only, and a narrow
`node:module.registerHooks` resolver injects a synthetic per-extension, per-generation API module
only for module graphs beneath a canonical registered extension root. Caxri does not install a
CommonJS loader interceptor or anonymous fallback API. Unowned API imports, CommonJS API access,
and extension-owned Electron imports fail with stable errors.

The process model deliberately chooses one Extension Host rather than a process per extension. It
keeps lifecycle and packaged startup small while providing failure isolation from Runtime and PTYs.
Opaque API tokens and generation fences isolate normal extension API state inside the shared child;
this is not an OS sandbox against malicious trusted Node code. A future untrusted-extension policy
would require a materially different process and platform sandbox design.

Builtin React views and extension trees share one Host descriptor catalog. Selection persists a
desired free-string ViewContainer ID and derives availability at render time, so extension removal
or failure never destroys user intent. Tree elements remain child-local and cross the boundary only
as bounded DTOs and opaque handles. See [Extension Host and view contributions](../extensions.md)
for the operational and authoring contract.
