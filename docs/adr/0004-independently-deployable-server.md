# Independently deployable Server and process ownership

- Status: accepted (target; implementation pending)
- Date: 2026-08-25
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Caxri packages one single-tenant Server as a self-contained directory artifact containing its pinned
runtime, bundles, platform-native dependencies, migrations, bundled Extensions, and protocol metadata.
Desktop, CLI, self-managed, and platform-managed deployments supervise the same artifact; the Server
never requires sibling Caxri workspaces at runtime. A platform fleet or account control plane remains a
separate product that orchestrates isolated Server instances, and supervision mode is independent from
local, direct, or Relay access.

The Server contains a restartable Server Core for access, domain services, persistence, and durable
change delivery; an independently discoverable Terminal Host for PTYs and Agent processes; and one
trusted Extension Host for Extension objects and Extension providers. The Server Core is the Terminal
Host's only supervisor: it starts the process detached and, on startup, authenticates and adopts one
compatible existing instance through a private owner-readable manifest, endpoint credential, build
handshake, and versioned internal protocol. An incompatible or unverifiable instance is terminated and
replaced, and affected Terminals become dead with a stable reason. A Server Core restart may therefore
preserve Terminals, while a Terminal Host crash may terminate them. Server artifact upgrades terminate
Terminals until descriptor handoff is implemented as a later product capability. This preserves the
trusted shared-process decision in [ADR 0003](./0003-host-owned-esm-extension-host.md) while replacing
the former generic Host and Runtime ownership model.
