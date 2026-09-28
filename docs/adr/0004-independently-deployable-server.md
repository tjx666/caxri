---
kind: adr
status: accepted
---

# Independently deployable Server and process ownership

- Date: 2026-08-25
- Note: artifact and process topology implemented; Terminal adoption pending P1
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Caxri packages one single-tenant Server as a self-contained directory artifact containing its pinned
runtime, bundles, platform-native dependencies, migrations, bundled Extensions, and protocol metadata.
Desktop, CLI, self-managed, and platform-managed deployments supervise the same artifact; the Server
never requires sibling Caxri workspaces at runtime. A platform fleet or account control plane remains a
separate product that orchestrates isolated Server instances, and supervision mode is independent from
local, direct, or Relay access.

The Server contains a restartable Server Core for access, domain services, persistence, and durable
change delivery; a separately running Terminal Host for PTYs and Agent processes; and one trusted
Extension Host for Extension objects and Extension providers. The Server Core is the Terminal Host's
only supervisor and starts it through a private credential, build handshake, and versioned internal
protocol. The A0–A7 implementation intentionally keeps lifecycle coupling and never adopts PTYs across
Server Core generations; compatible discovery and adoption are deferred to P1, while live descriptor
handoff remains P5. Until then, Server Core or Terminal Host replacement terminates affected Terminals
with a stable reason. This preserves the
trusted shared-process decision in [ADR 0003](./0003-host-owned-esm-extension-host.md) while replacing
the former generic Host and Runtime ownership model.
