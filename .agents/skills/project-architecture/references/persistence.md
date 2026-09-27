# SQLite, Session state, and snapshots

SQLite runs only in the Server Core and uses WAL, foreign keys, transactions, and busy timeout. Table definitions live declaratively in `apps/server/src/domains/db/schema.ts` (Drizzle ORM); `bunx --bun drizzle-kit generate` emits the checked-in SQL under `apps/server/src/domains/db/migrations/`, which the Server Core bundles via the validated `migrations/manifest.ts` `?raw` imports so packaged builds never read migration files from disk. After any schema change, regenerate with drizzle-kit, then add the generated migration to that manifest — never hand-edit the migrations directory. The manifest must match the Drizzle journal exactly. `0000_baseline` is the owner-declared clean-install cutoff taken before open-sourcing: it writes `user_version` 39, every earlier `user_version` belongs to an unpublished development build and is rebuilt (metadata only; Project folders and user files are never touched), and each later migration advances `user_version` by one while preserving Projects, Sessions, Terminals, snapshots, selection, and layout state. `PRAGMA user_version` is the only stored schema version. Caxri's public data-compatibility commitment begins with v1.0.0, backed by the post-baseline chain; adding a schema version requires both generated SQL and an N-1 upgrade test.

Integrity lives in the schema, not only in model code: foreign keys cascade owned worktree Projects (`owner_project_id`) and null a deleted primary Agent Terminal (`primary_agent_terminal_id`), `(session_id, order_index)` is unique, and closed protocol enums carry `CHECK` constraints whose value lists are type-checked against the protocol unions in `schema.ts`. Open-ended columns such as `terminals.kind` and `provider` deliberately stay unconstrained so a new Agent provider never forces a table rebuild. Row IDs stored inside `app_state` JSON and the `agent_delegations` / `agent_dispatch_receipts` ID projections are outside any foreign key by design; `schema.ts` documents which code keeps each one consistent. Query modules use the Drizzle query builder while the raw better-sqlite3 handle remains for pragmas and transactions. The schema contains:

- `projects`: identity, unique root, display title, explicit Primary Sidebar order, timestamps, and the reversible `hidden_at` mark
- `sessions`: Project ownership, identity, creation/visit timestamps, the allowlisted Session Activity clock and reason, independent sidebar order, reversible archive time, primary Agent Terminal and Agent Activity state, attention generations, and automatic/manual title ownership

- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with source grid, line, and byte counts
- `session_state`: versioned open editor tabs, active tab, desired Secondary Sidebar ViewContainer ID, recursive Terminal split layout, and the last durable file-mutation editor-remap operation ID so at-least-once recovery stays idempotent across Renderer reloads; invalid JSON, invalid shapes, or unsupported versions repair to a default layout and emit a content-free warning instead of failing bootstrap
- `app_state`: last selected Project and Session, window state, active theme, and external delegation Session bindings

Session sidebar order is explicit within each Project. A relative `session.reorder` command moves one
active Session before or after another active Session in that same Project, inside the structural
command transaction. It never changes activity or visit timestamps. Each existing meaningful activity
write atomically promotes only its affected Session by updating the sidebar position alongside the
activity clock; new Sessions start first. Renderer freezes the displayed sequence during a drag but
does not suspend Server activity writes or replay earlier activity after the drop. Navigation and
Server fallback selection share the sidebar comparator; actual activity history remains independent.

A successfully parsed Workbench Root snapshot is also checked against the Session's current durable
Terminal ownership. Historical tabs for deleted Terminals are pruned on first read and that Root is
rewritten immediately, while sibling Root snapshots, extension Tree View state, and editor-remap
identity remain intact. A first visit also persists its generated Root layout before subsequent
bootstrap reads can replace pane and tab identities. Renderer pane portals preserve a surviving
visible Terminal across Root layouts and split placement without retaining hidden tab contents;
see [view placement](../../../../docs/adr/0002-unified-pane-layout.md#view-placement).

Snapshots retain at most 2,000 lines and 2 MiB per Terminal. Each live PTY owns a Terminal Host-side
headless xterm screen whose ordered write and resize queue preserves cursor-addressed state. A live
attach first moves that screen and PTY to the receiving Renderer grid, then crosses an exact queue
barrier and replays a bounded serialized screen before later output. A Renderer subscribes before
attaching, then replays that bounded snapshot ahead of output received during attachment. Two rules
keep that snapshot and that replay disjoint, because either alone leaves a duplicate. Bytes still
queued in Terminal Host are removed from the live-output queue before replay, and Server Core stops
forwarding output from the moment it accepts a re-attachment rather than when it rotates the
attachment id — a byte the Host flushed just before the snapshot is already on the parsed screen, so
forwarding it during that window would replay what the snapshot is about to write. Server Core
therefore gates output on the view the Renderer asked for, not on the attachment the Host is still
using. Detached Terminals retain the parsed screen in memory without broadcasting output to an
invisible view. Exit, restart, and orderly or terminate shutdown persist that same parsed screen plus
its exact source grid as encoding 3 after excluding interaction modes; raw PTY bytes are never durable
recovery data. Renderer recovery disconnects normal resize observation, restores the serialized
framebuffer at that source grid, waits for xterm parsing and buffered output to finish, then fits once
to the current pane and resumes observation. Older, malformed, or unknown encodings fail closed and
restore an empty screen. An unclean Server or Terminal Host loss can therefore lose the current
generation's latest visual history instead of replaying unsafe raw input. Snapshots are UI restoration
data, not proof that a process survived.
