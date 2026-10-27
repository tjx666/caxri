# Documentation index

Every file under `docs/**/*.md` is listed here exactly once, grouped by its frontmatter `kind`. See
[write-docs](../.agents/skills/write-docs/SKILL.md) for what each kind owns, the frontmatter
contract, and when to update or retire a doc. `bun run scripts/documentation-check.ts` fails when
this index drifts from the files on disk.

The product glossary lives in [GLOSSARY.md](../GLOSSARY.md), not here: it defines terms, this index
explains behavior.

## Start here (users)

Plain-language guides for people using Caxri. All are living docs and are also listed below.

- [install.md](install.md): install Caxri, or have a coding agent do it.
- [getting-started.md](getting-started.md): the model in five minutes.
- [troubleshooting.md](troubleshooting.md): blocked app, notifications, Agent not found, logs and reset.

## Living docs

What/why of current shipped behavior, core modules, protocols, and operator knowledge.

| Doc                                                                | Covers                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [activity-view.md](activity-view.md)                               | Activity view: attention queue, excerpts, return hint               |
| [agent-actions.md](agent-actions.md)                               | Unified Agent skills and slash-command picker                       |
| [agent-chat.md](agent-chat.md)                                     | Chat Terminals for Codex, Claude Code, and Grok Build               |
| [agent-command-authority.md](agent-command-authority.md)           | Separate Agent command domains and their authority boundaries       |
| [agent-usage-continuation.md](agent-usage-continuation.md)         | Usage-limit recovery, weekly usage guard, continue in another Agent |
| [caxri-bot.md](caxri-bot.md)                                       | Second-window Codex or Claude Code bot and Agent board              |
| [agent-delegation.md](agent-delegation.md)                         | Visible Agent delegation into a sibling pane                        |
| [agent-dispatch-receipts.md](agent-dispatch-receipts.md)           | Managed dispatch launch requests and observed process lifetime      |
| [agent-suspension.md](agent-suspension.md)                         | Parking idle background Agents and resuming them on return          |
| [airplane-mode.md](airplane-mode.md)                               | Compact, stop every Agent before going offline, resume on return    |
| [agent-throughput.md](agent-throughput.md)                         | Agent output speed (tok/s) in the status bar                        |
| [architecture-debt.md](architecture-debt.md)                       | Persistent architecture-debt audit ledger                           |
| [benchmark.md](benchmark.md)                                       | Benchmark tab: one prompt across Agents, models, and efforts        |
| [bundle-size.md](bundle-size.md)                                   | Packaged app size baseline and the CI budget gate                   |
| [ci-performance.md](ci-performance.md)                             | CI/E2E execution profiles and performance evidence                  |
| [claude-windows.md](claude-windows.md)                             | Keeping Claude 5-hour windows rolling from a morning anchor         |
| [client-local-data.md](client-local-data.md)                       | Device store, Editor hot exit, drafts, offline decisions            |
| [cli.md](cli.md)                                                   | The `caxri` CLI manual                                              |
| [desktop-updates.md](desktop-updates.md)                           | Background download, Restart to Update, in-place install            |
| [project-transfer.md](project-transfer.md)                         | Export and import of Projects and Sessions                          |
| [editor-imports.md](editor-imports.md)                             | Editor import navigation                                            |
| [editor-worker-stalls.md](editor-worker-stalls.md)                 | Editor Worker stall diagnostics                                     |
| [extensions.md](extensions.md)                                     | Extension Host process and view contributions                       |
| [external-status-quota.md](external-status-quota.md)               | External delivery-status reads and quota governance                 |
| [getting-started.md](getting-started.md)                           | Projects, Sessions, Chat, attention, and menus in five minutes      |
| [file-preview.md](file-preview.md)                                 | Markdown and SVG preview tabs                                       |
| [git-diff-review.md](git-diff-review.md)                           | Git diff review comments                                            |
| [git-status-snapshot.md](git-status-snapshot.md)                   | Incremental Git topology/status pipeline                            |
| [grok-build.md](grok-build.md)                                     | Grok Build terminal integration                                     |
| [hook-installation-authority.md](hook-installation-authority.md)   | Provider hook installation authority                                |
| [hook-turn-recovery.md](hook-turn-recovery.md)                     | Lifecycle hook turn recovery                                        |
| [i18n.md](i18n.md)                                                 | Interface languages, translation resources, and terminology         |
| [install.md](install.md)                                           | Agent-executable install steps and optional initial settings        |
| [keybindings.md](keybindings.md)                                   | Keybinding format and chord sequences                               |
| [low-cost-generation.md](low-cost-generation.md)                   | Automatic Session-naming sandbox                                    |
| [notifications.md](notifications.md)                               | Notification center history and reminders                           |
| [open-sessions.md](open-sessions.md)                               | Per-window Open Session, secondary windows, and presence            |
| [process-explorer.md](process-explorer.md)                         | Process Explorer, resource thresholds, and runaway alerts           |
| [performance-monitor.md](performance-monitor.md)                   | Draggable frame rate monitor and reload timeline                    |
| [provider-messaging.md](provider-messaging.md)                     | Peer Inbox provider-messaging support and the verified matrix       |
| [quality-toolchain.md](quality-toolchain.md)                       | Unified mechanical-quality tooling                                  |
| [renderer-performance.md](renderer-performance.md)                 | Renderer performance observability                                  |
| [secondary-sidebar-trees.md](secondary-sidebar-trees.md)           | Files/Source Control/extension tree rendering                       |
| [troubleshooting.md](troubleshooting.md)                           | Blocked app, notifications, missing Agent, logs, and reset          |
| [startup-performance.md](startup-performance.md)                   | Launch milestone log, packaged startup runner, rejected tricks      |
| [server-architecture.md](server-architecture.md)                   | Current Server/Client architecture contract                         |
| [server-footprint.md](server-footprint.md)                         | SSH Host Server memory and disk requirements and the baseline       |
| [session-compaction.md](session-compaction.md)                     | Batch command and idle Chat compaction                              |
| [session-search.md](session-search.md)                             | Session search across Caxri and external Agent conversations        |
| [session-conversation-context.md](session-conversation-context.md) | Reading a Session's own Agent conversation                          |
| [ssh-host.md](ssh-host.md)                                         | SSH Host windows: connect, install, lifecycle, remote layers        |
| [terminal-reference-preview.md](terminal-reference-preview.md)     | Terminal commit/reference hover previews                            |
| [type-aware-linting.md](type-aware-linting.md)                     | ESLint (syntactic) + oxlint/tsgolint (typed) split                  |
| [usage.md](usage.md)                                               | Usage page: token, cost, and delivery statistics                    |
| [mobile/apk-size.md](mobile/apk-size.md)                           | Android internal APK size                                           |
| [mobile/authorization.md](mobile/authorization.md)                 | Mobile device pairing and method authorization                      |
| [mobile/changes.md](mobile/changes.md)                             | Mobile read-only Git Changes segment                                |
| [mobile/conversation.md](mobile/conversation.md)                   | Mobile read-only Agent conversation timeline                        |
| [mobile/design.md](mobile/design.md)                               | Caxri Mobile design and interaction spec                            |
| [mobile/host-status.md](mobile/host-status.md)                     | Mobile computer status: CPU, memory, Session load, processes        |
| [mobile/performance.md](mobile/performance.md)                     | Mobile release performance budgets                                  |
| [mobile/preview.md](mobile/preview.md)                             | Mobile preview of a Session's local web pages                       |
| [mobile/transport.md](mobile/transport.md)                         | Mobile gateway transport, pairing, and framing                      |
| [mobile/update.md](mobile/update.md)                               | Mobile app self-update from Desktop                                 |

## ADRs

Decisions that are hard to reverse, surprising without context, and a real trade-off. Never
rewritten, only superseded.

| ADR                                                           | Decision                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| [0001](adr/0001-separate-session-owner-and-workbench-root.md) | Separate Session ownership from the Workbench Root                 |
| [0002](adr/0002-unified-pane-layout.md)                       | One pane tree for Terminals and documents                          |
| [0003](adr/0003-host-owned-esm-extension-host.md)             | Host-owned native ESM Extension Host                               |
| [0004](adr/0004-independently-deployable-server.md)           | Independently deployable Server and process ownership              |
| [0005](adr/0005-multi-client-state-ownership.md)              | Multi-Client identity and state ownership                          |
| [0006](adr/0006-durable-changefeed-and-streaming-protocol.md) | Durable changefeed and streaming protocol                          |
| [0007](adr/0007-remote-access-and-project-authorization.md)   | Remote access and Project authorization                            |
| [0008](adr/0008-agent-native-observability.md)                | Agent-native observability and diagnostics                         |
| [0009](adr/0009-session-activity-recency.md)                  | Session Activity owns Primary Sidebar recency                      |
| [0010](adr/0010-server-core-idle-exit.md)                     | Server Core idle-exit policy                                       |
| [0011](adr/0011-required-merge-guards.md)                     | A required `guards` check replaces direct pushes to `main`         |
| [0012](adr/0012-agent-chat-surface.md)                        | Agent Chat: a structured Terminal surface beside the PTY           |
| [0013](adr/0013-editable-external-documents.md)               | Editable external documents through a Main-issued registry         |
| [0014](adr/0014-ssh-remote-server.md)                         | SSH Hosts run their own Server over system OpenSSH                 |
| [0015](adr/0015-chat-primary-agent-surface.md)                | Agent Chat is the primary Agent surface; Terminal stays supported  |
| [0016](adr/0016-github-hosted-ci.md)                          | GitHub-hosted CI with explicitly authorized full E2E               |
| [0017](adr/0017-per-window-session-presence.md)               | Per-window Open Sessions and presence replace one selected Session |
| [0018](adr/0018-macos-ssh-hosts.md)                           | macOS on Apple silicon is a supported SSH Host                     |
| [0019](adr/0019-extension-view-request-scope.md)              | Extension view requests carry their own Session scope              |
| [0020](adr/0020-agent-development-environment.md)             | Caxri is an ADE: product and development principles                |

## Historical

Retired plans, spikes, and research notes kept only because a current doc cites them as evidence.

| Doc                                                        | Kept because                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [oxlint-spike.md](oxlint-spike.md)                         | Evidence record cited by `type-aware-linting.md` and `quality-toolchain.md`      |
| [server-refactor-plan.md](server-refactor-plan.md)         | Implemented A0–A7 migration plan cited as `Implementation plan` by ADR 0004–0008 |
| [refactor-behavior-parity.md](refactor-behavior-parity.md) | Acceptance methodology cited by `server-refactor-plan.md`                        |
