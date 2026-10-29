# SQLite, Session state, and snapshots

SQLite runs only in the Server Core and uses WAL, foreign keys, transactions, and busy timeout. Table definitions live declaratively in `apps/server/src/domains/db/schema/` (Drizzle ORM; `index.ts` joins every file); `bunx --bun drizzle-kit generate` emits the checked-in SQL under `apps/server/src/domains/db/migrations/`, which the Server Core bundles via the validated `migrations/manifest.ts` `?raw` imports so packaged builds never read migration files from disk. After any schema change, regenerate with drizzle-kit, then add the generated migration to that manifest; never hand-edit the migrations directory except for the generated-column fix below. The manifest must match the Drizzle journal exactly. `apps/server/src/domains/db/__tests__/schema-migration-drift.test.ts` replays `drizzle-kit generate` in memory against the newest `migrations/meta` snapshot and fails while the schema has a change no checked-in migration covers. `0000_baseline` is the owner-declared clean-install cutoff: it writes `user_version` 55, every earlier `user_version` belongs to an earlier development build and is rebuilt (metadata only; Project folders and user files are never touched; `rebuild-backup.ts` keeps a `VACUUM INTO` copy first, see [docs/desktop-updates.md](../../../../docs/desktop-updates.md#updates-that-clear-data)), and each later migration advances `user_version` by one while preserving Projects, Sessions, Terminals, snapshots, selection, and layout state. The rebuild drops every table `sqlite_master` lists, so a table a later schema renamed or removed can never collide with the baseline; it carries only the `agent_chat_process_groups` rows across, so the startup sweep still reaps the Agent process groups a killed Server Core left running. A carry reads the old table by the column names it actually has (`pragma_table_info`), because the next baseline bump rebuilds databases this baseline wrote, and its regression seeds the old column shape rather than the current schema. `PRAGMA user_version` is the only stored schema version. Caxri's public data-compatibility commitment begins with v1.0.0, backed by the post-baseline chain; adding a schema version requires both generated SQL and an N-1 upgrade test. An N-1 upgrade test anchors on the migration's tag: it builds its starting database by replaying the `migrationManifest` entries before that tag through the runner's `executableMigrationSql`, never with an offset from `CURRENT_SCHEMA_VERSION` or hand-dropped later tables, so appending a migration never edits an older test. `caxri/no-schema-version-offset` (`scripts/eslint-rules/no-schema-version-offset.ts`) rejects `CURRENT_SCHEMA_VERSION - n` in test files.

Table rebuilds follow the same path. SQLite cannot change most column constraints in place, so
drizzle-kit emits a create-copy-drop-rename rebuild of the table. Generate the migration with
`bunx --bun drizzle-kit generate` and commit its SQL unchanged, including the standalone
`PRAGMA foreign_keys=OFF;` and `PRAGMA foreign_keys=ON;` statements drizzle-kit writes around a
table rebuild: the migration runner drops them and owns the foreign-key toggle. The runner in
`apps/server/src/domains/db/connection.ts` applies every pending migration under SQLite's
[procedure for other schema changes](https://www.sqlite.org/lang_altertable.html#otheralter): it
disables foreign keys before opening the migration transaction (`PRAGMA foreign_keys` is a no-op
inside one), requires an empty `PRAGMA foreign_key_check` before commit, rolls back otherwise, and
re-enables foreign keys either way. That is what lets a parent table (`projects`, `sessions`,
`terminals`) be rebuilt: with enforcement on, `DROP TABLE` of a parent performs an implicit
`DELETE` that fires `ON DELETE CASCADE` and wipes its child rows, even the ones already copied into
the replacement table. The trade-off is that no cascade or `SET NULL` action fires during a
migration, so a migration that removes parent rows deletes or detaches their children explicitly
or the check rolls it back. Any other `PRAGMA foreign_keys` in migration SQL fails the guard, whose
error repeats the rule above. `apps/server/src/domains/db/__tests__/migration-sql-guard.test.ts`
keeps the two sentences identical, and
`apps/server/src/domains/db/__tests__/table-rebuild-migration.integration.test.ts` proves a
generated parent rebuild keeps its children and a rebuild that leaves a dangling reference rolls
back.

The one hand edit a generated migration takes: drizzle-kit 0.31 lists generated columns (such as
`terminals.provider`) in a table rebuild's `INSERT INTO \`__new_<table>\`(...) SELECT ...`copy, and
SQLite refuses to insert into one, so the migration fails on every database that has a row. Remove
the generated column from both column lists of that statement and change nothing else. The`migration-sql-guard.test.ts`generated-column check fails until it is removed, and the
migration's N-1 upgrade test (for example`apps/server/src/domains/db/**tests**/terminal-pty-exhausted-migration.integration.test.ts`)
proves the copy keeps existing rows.

Each Server Core start writes one `db.opened` record: the closed schema `outcome` (`created`,
`current`, `migrated`, `rebuilt`), `fromVersion`, `toVersion`, `durationMs`, and how many Terminal
and Agent process states the unclean-shutdown recovery moved to `interrupted`. An orderly shutdown
marks them first, so nonzero counts mean the previous Server Core was killed; those and a rebuild
log at `warn`. `domains/db` stays logger-free and reports through `onOpened`, which
`root-services.ts` turns into the record.

A rebuild also writes the `lastDatabaseRebuild` `app_state` cell (`at`, `fromVersion`, `backupPath`) inside the rebuild transaction, and `db.opened` carries `droppedTableCount`. Only the latest rebuild is kept; `host.status` and the diagnostics snapshot expose it with the backup path home-normalized, and omit it when no rebuild ever happened. There is no restore path: the `.bak` is for hand recovery.

Renaming a table makes `drizzle-kit generate` ask, per new table, whether it is created or renamed
from an old one, and it needs a TTY to ask. An agent shell has none, so drive it through a PTY with
`expect` and answer each prompt from an explicit old-to-new table mapping, never a fixed key
sequence. A rename also has to keep every historical migration file and tag unchanged.

Integrity lives in the schema, not only in model code: foreign keys cascade owned worktree Projects (`owner_project_id`) and null a deleted primary Agent Terminal (`primary_agent_terminal_id`), `(session_id, order_index)` is unique, and closed protocol enums carry `CHECK` constraints whose value lists are type-checked against the protocol unions through `schema/constraints.ts` (the drift test above, not that type check, catches a widened list without its rebuilt constraint). Cross-column invariants the product relies on are `CHECK`s too: a closed Inbox item has its reason and time, and a pending Caxri Bot notice has exactly the columns its kind uses. Open-ended columns such as `terminals.kind` and the provider columns deliberately stay unconstrained so a new Agent provider never forces a table rebuild. Values another column already determines are generated columns, never a second write: `terminals.provider` is `kind` unless it is a Shell, and `agent_delegations.status` / `terminal_id` are projected from the stored receipt. Row IDs stored inside `app_state` JSON and the `agent_delegations` / `agent_dispatch_receipts` / `agent_session_usage` ID projections are outside any foreign key by design; `schema/core.ts` documents which code keeps each one consistent. Query modules use the Drizzle query builder while the raw better-sqlite3 handle remains for pragmas and transactions. The schema contains:

- `projects`: identity, unique root, display title, explicit Primary Sidebar order, timestamps, and the reversible `hidden_at` mark
- `sessions`: Project ownership, identity, creation/visit timestamps, the allowlisted Session Activity clock and reason, independent sidebar order, reversible archive time, primary Agent Terminal and Agent Activity state, attention generations, the last time the user stopped looking at it (`last_viewed_at`, written from window presence through `SessionViewsModel`, never a visit or activity), and automatic/manual title ownership

- `terminals`: durable identity/position/cwd/title, the generated `provider`, and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with source grid, line, and byte counts
- `session_views`: versioned open editor tabs, active tab, desired Secondary Sidebar ViewContainer ID, recursive Terminal split layout, and the last durable file-mutation editor-remap operation ID so at-least-once recovery stays idempotent across Renderer reloads; invalid JSON, invalid shapes, or unsupported versions repair to a default layout and emit a content-free warning instead of failing bootstrap
- `app_state`: last selected Project and Session, window state, active theme, external delegation Session bindings, and the mobile gateway preferences (`mobileGateway`)
- `agent_session_usage`: append-only ledger of every Agent Session a Caxri Terminal hosted (provider, provider session ID, first owning Session and Project, transcript fingerprint, and the content-free usage aggregate); it outlives Session and Project deletion on purpose, so it holds those IDs without foreign keys
- `external_agent_usage`: scan cache of Agent transcripts found outside that ledger for the Usage page's This Mac scope, one row per transcript file (provider, transcript ID, Agent Session ID, working directory, fingerprint, and the content-free aggregate); see [docs/usage.md](../../../../docs/usage.md)
- `claude_window_schedules`: per Claude account (keyed by the SHA-256 of its email and organization, never the plain values) the 5-hour window keeper's switch, `First workday reset at`, the last processed planned time written before a send so it never repeats, the observed reset, and the last outcome; see [docs/claude-windows.md](../../../../docs/claude-windows.md)
- `pull_request_outcomes`: GitHub state, title, merge time, and line counts of pull requests an Agent created, keyed by URL
- `agent_chat_answered_notices`: the `Answered: ...` notices Server Core records in an Agent Chat, which no provider history can rebuild, keyed by Terminal and item with the turn and the item each followed; cascades with the Terminal and is pruned when a history replay no longer holds the turn. `terminals.chat_resume_record_id` holds a rewound Claude Chat's resume record until its first new turn
- `agent_chat_subagents`: per-Chat summary of each subagent task (task id, title, agent type, closed status, start and end times) so the sidebar can list them without reading a Chat; cascades with the Terminal, capped at 50 per Chat, running rows become stopped on Server Core start; see [docs/agent-chat.md](../../../../docs/agent-chat.md)
- `agent_chat_process_groups`: process group IDs of live Agent Chat provider children with the leader's start time, so the next Server Core start can reap the groups a killed one left behind without signaling a reused ID; no foreign key, holds no conversation content
- `bot_tasks`: Caxri Bot's task ledger (title, closed status, Project and Session that null on deletion, root delegation ID unique per task, note, pull request URL); see [docs/caxri-bot.md](../../../../docs/caxri-bot.md)
- `bot_pending_notices`: delegation notices the Caxri Bot Terminal has not received yet and the marker for a Caxri Bot turn that has not finished, deleted when consumed
- `mobile_devices`: paired phones (display name, closed platform and role, pairing secret, revocation generation, granted Project IDs, connection and revocation times); `MobileDeviceRegistry` owns the decisions and rewrites the whole set per mutation; see [docs/mobile/authorization.md](../../../../docs/mobile/authorization.md)
- `delegation_clients`: delegation clients the owner CLI minted (binding Project, Session, and caller provider, SHA-256 token digest, generation, expiry, revocation); `DelegationAccessRegistry` owns the decisions. Neither credential table has foreign keys: authorization fences a stale grant when a request arrives
- `bot_inbox_items` and `bot_inbox_replies`: the [Bot Inbox](../../../../docs/caxri-bot.md#bot-inbox), what Caxri Bot raised for the owner and the owner's replies; Session and delegation IDs are context without foreign keys, and the tables live in `schema/bot.ts` beside the task ledger

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
attachment id: a byte the Host flushed just before the snapshot is already on the parsed screen, so
forwarding it during that window would replay what the snapshot is about to write. Server Core
therefore gates output on the view the Renderer asked for, not on the attachment the Host is still
using. Detached Terminals retain the parsed screen in memory without broadcasting output to an
invisible view. Exit, restart, suspension, termination, and orderly shutdown persist that same parsed screen plus
its exact source grid as encoding 3 after excluding interaction modes; raw PTY bytes are never durable
recovery data. Renderer recovery disconnects normal resize observation, restores the serialized
framebuffer at that source grid, waits for xterm parsing and buffered output to finish, then fits once
to the current pane and resumes observation. Older, malformed, or unknown encodings fail closed and
restore an empty screen. An unclean Server or Terminal Host loss can therefore lose the current
generation's latest visual history instead of replaying unsafe raw input. Snapshots are UI restoration
data, not proof that a process survived.
