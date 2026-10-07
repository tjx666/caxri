# Documentation index

Every file under `docs/**/*.md` is listed here exactly once, grouped by its frontmatter `kind`. See
[write-docs](../.agents/skills/write-docs/SKILL.md) for what each kind owns, the frontmatter
contract, and when to update or retire a doc. `bun run scripts/documentation-check.ts` fails when
this index drifts from the files on disk.

The product glossary lives in [GLOSSARY.md](../GLOSSARY.md), not here — it defines terms, this index
explains behavior.

## Living docs

What/why of current shipped behavior, core modules, protocols, and operator knowledge.

| Doc                                                                | Covers                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| [activity-view.md](activity-view.md)                               | The Activity view's cross-Project attention queue              |
| [agent-actions.md](agent-actions.md)                               | Unified Agent skills and slash-command picker                  |
| [agent-command-authority.md](agent-command-authority.md)           | Separate Agent command domains and their authority boundaries  |
| [agent-commander.md](agent-commander.md)                           | Second-window Codex commander and cross-Project Agent board    |
| [agent-delegation.md](agent-delegation.md)                         | Visible Agent delegation into a sibling pane                   |
| [agent-dispatch-receipts.md](agent-dispatch-receipts.md)           | Managed dispatch launch requests and observed process lifetime |
| [architecture-debt.md](architecture-debt.md)                       | Persistent architecture-debt audit ledger                      |
| [bundle-size.md](bundle-size.md)                                   | Packaged app size baseline and the CI budget gate              |
| [ci-performance.md](ci-performance.md)                             | CI/E2E execution profiles and performance evidence             |
| [cli.md](cli.md)                                                   | The `caxri` CLI manual                                         |
| [editor-imports.md](editor-imports.md)                             | Editor import navigation                                       |
| [editor-worker-stalls.md](editor-worker-stalls.md)                 | Editor Worker stall diagnostics                                |
| [extensions.md](extensions.md)                                     | Extension Host process and view contributions                  |
| [external-status-quota.md](external-status-quota.md)               | External delivery-status reads and quota governance            |
| [file-preview.md](file-preview.md)                                 | Markdown and SVG preview tabs                                  |
| [git-diff-review.md](git-diff-review.md)                           | Git diff review comments                                       |
| [git-status-snapshot.md](git-status-snapshot.md)                   | Incremental Git topology/status pipeline                       |
| [grok-build.md](grok-build.md)                                     | Grok Build terminal integration                                |
| [hook-installation-authority.md](hook-installation-authority.md)   | Provider hook installation authority                           |
| [hook-turn-recovery.md](hook-turn-recovery.md)                     | Lifecycle hook turn recovery                                   |
| [keybindings.md](keybindings.md)                                   | Keybinding format and chord sequences                          |
| [low-cost-generation.md](low-cost-generation.md)                   | Automatic Session-naming sandbox                               |
| [notifications.md](notifications.md)                               | Notification center history and reminders                      |
| [process-explorer.md](process-explorer.md)                         | Process Explorer, resource thresholds, and runaway alerts      |
| [provider-messaging.md](provider-messaging.md)                     | Peer Inbox provider-messaging support and the verified matrix  |
| [quality-toolchain.md](quality-toolchain.md)                       | Unified mechanical-quality tooling                             |
| [renderer-performance.md](renderer-performance.md)                 | Renderer performance observability                             |
| [secondary-sidebar-trees.md](secondary-sidebar-trees.md)           | Files/Source Control/extension tree rendering                  |
| [self-hosted-runner.md](self-hosted-runner.md)                     | Self-hosted macOS CI/release runner                            |
| [startup-performance.md](startup-performance.md)                   | Launch milestone log, packaged startup runner, rejected tricks |
| [server-architecture.md](server-architecture.md)                   | Current Server/Client architecture contract                    |
| [session-compaction.md](session-compaction.md)                     | Batch Session compaction command                               |
| [session-content-search.md](session-content-search.md)             | Session content search                                         |
| [session-conversation-context.md](session-conversation-context.md) | Reading a Session's own Agent conversation                     |
| [terminal-reference-preview.md](terminal-reference-preview.md)     | Terminal commit/reference hover previews                       |
| [type-aware-linting.md](type-aware-linting.md)                     | ESLint (syntactic) + oxlint/tsgolint (typed) split             |
| [mobile/apk-size.md](mobile/apk-size.md)                           | Android internal APK size                                      |
| [mobile/authorization.md](mobile/authorization.md)                 | Mobile device pairing and method authorization                 |
| [mobile/changes.md](mobile/changes.md)                             | Mobile read-only Git Changes segment                           |
| [mobile/conversation.md](mobile/conversation.md)                   | Mobile read-only Agent conversation timeline                   |
| [mobile/design.md](mobile/design.md)                               | Caxri Mobile design and interaction spec                       |
| [mobile/performance.md](mobile/performance.md)                     | Mobile release performance budgets                             |
| [mobile/transport.md](mobile/transport.md)                         | Mobile gateway transport, pairing, and framing                 |
| [mobile/update.md](mobile/update.md)                               | Mobile app self-update from Desktop                            |

## ADRs

Decisions that are hard to reverse, surprising without context, and a real trade-off. Never
rewritten, only superseded.

| ADR                                                           | Decision                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| [0001](adr/0001-separate-session-owner-and-workbench-root.md) | Separate Session ownership from the Workbench Root         |
| [0002](adr/0002-unified-pane-layout.md)                       | One pane tree for Terminals and documents                  |
| [0003](adr/0003-host-owned-esm-extension-host.md)             | Host-owned native ESM Extension Host                       |
| [0004](adr/0004-independently-deployable-server.md)           | Independently deployable Server and process ownership      |
| [0005](adr/0005-multi-client-state-ownership.md)              | Multi-Client identity and state ownership                  |
| [0006](adr/0006-durable-changefeed-and-streaming-protocol.md) | Durable changefeed and streaming protocol                  |
| [0007](adr/0007-remote-access-and-project-authorization.md)   | Remote access and Project authorization                    |
| [0008](adr/0008-agent-native-observability.md)                | Agent-native observability and diagnostics                 |
| [0009](adr/0009-session-activity-recency.md)                  | Session Activity owns Primary Sidebar recency              |
| [0010](adr/0010-server-core-idle-exit.md)                     | Server Core idle-exit policy                               |
| [0011](adr/0011-required-merge-guards.md)                     | A required `guards` check replaces direct pushes to `main` |

## Historical

Retired plans, spikes, and research notes kept only because a current doc cites them as evidence.

| Doc                                                        | Kept because                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [oxlint-spike.md](oxlint-spike.md)                         | Evidence record cited by `type-aware-linting.md` and `quality-toolchain.md`      |
| [server-refactor-plan.md](server-refactor-plan.md)         | Implemented A0–A7 migration plan cited as `Implementation plan` by ADR 0004–0008 |
| [refactor-behavior-parity.md](refactor-behavior-parity.md) | Acceptance methodology cited by `server-refactor-plan.md`                        |
