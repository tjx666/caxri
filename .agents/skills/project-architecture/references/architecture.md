# Caxri architecture

This is a navigation index. Start with the decision table in [the skill](../SKILL.md), then read
the owning topic. Contracts live in the linked files; this index does not duplicate them.

## Product model

[Projects, Sessions, and Workbench Roots](product-model.md) owns identity, metadata-only deletion,
root-scoped state, naming ownership, and notification history.

## Process model

[Process ownership](process-model.md) maps Desktop Main, Server Core, Preload, Renderer, and Hosts,
including profiles, the Desktop lease, reset ownership, and restart limits.

## IPC contract

- [IPC](ipc.md): schemas, capabilities, errors, durable events, and Preload.
- [Packages](packages.md): import boundaries, mobile isolation, and Server composition.
- [CLI](cli.md): human and Agent CLI authority and the distributed Agent guide.

## Persistence

[Persistence](persistence.md) owns SQLite, migrations, Session state, and bounded Terminal snapshots.

## PTY lifecycle and backpressure

- [Terminal lifecycle](terminal-lifecycle.md): launch, observation, suspension, detach, and restore.
- [Terminal interaction](terminal-interaction.md): input/backpressure, links, layout, and actions.

## Files and editor

- [Files and paths](files-and-paths.md): filesystem authority, workspace links, browsing, and mutations.
- [Editor and search](editor-and-search.md): buffers, external updates, project search, and diff surfaces.
- [Agent identity](agent-identity.md): provider catalogs and Renderer identity assets.

## Settings, keybindings, and themes

[Settings and themes](settings-and-themes.md) owns persisted settings and shared presentation tokens.
Save containment belongs to [Files and paths](files-and-paths.md).

## Git and Agent adapters

- [Git](git.md): approved repositories, worktree attribution, history, exclusions, and Project Status.
- [Agent identity](agent-identity.md): provider metadata, names, and managed launches.
- [Agent messaging](agent-messaging.md): Endpoint authority, Inbox, dispatch, and human steering.
- [Agent hooks](agent-hooks.md): provider hook events, generation fencing, and bridge installation.

## Security

[Security](security.md) owns BrowserWindow isolation and native filesystem grants. Follow
[Files and paths](files-and-paths.md) for workspace links and [Agent messaging](agent-messaging.md)
for generation-scoped Endpoint authority.

## Performance and observability

[Performance](performance.md) owns hot-path costs and startup/Renderer measurements.

## Diagnostics and privacy

[Diagnostics](diagnostics.md) owns log schemas, privacy, retention, and correlated GPU recovery.

## Recovery limits

Use [Process model](process-model.md) for crash/restart limits and
[Terminal lifecycle](terminal-lifecycle.md) for PTY restore, suspension, and detach.
