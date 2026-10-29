# Feature references

Which external projects shaped which shipped Caxri features, and what was taken from each. Use it to
find the precedent a surface already follows before changing it, and to credit sources before a
public release. Per-product research lives in the sibling `<product>.md` notes; this file records
only adoption.

Rules for entries:

- Record an entry only with explicit evidence: a doc sentence, a code comment, or a commit message.
  Similarity alone is not evidence.
- Borrowed names the idea, interaction, value, or format taken. Copied code, assets, or text must
  also have a `THIRD_PARTY_NOTICES.md` entry; this file does not replace it.
- Evidence paths are repository-relative. Prefer the code comment or doc that states the precedent.
- Add the entry in the same change that ships the feature. Group it under its reference project,
  and add the project's section when it has none.
- Keep each entry on one line, shaped as `- **Feature**: Borrowed. Evidence: paths.` (add
  `Reference: Product.` before Evidence in a shared section). `.gitattributes` merges this file
  with `merge=union`, so parallel branches appending to the same section keep both lines instead of
  conflicting; a wrapped or tabular entry would interleave.

Seeded on 2026-10-13 from an evidence sweep of docs, code comments, and commit history.

## VS Code (MIT; Codicons CC BY 4.0)

- **VS Code theme import; tab, list, badge, Git roles**: Theme keys and registry default colors. Evidence: `DESIGN.md` (theme roles); `apps/server/src/domains/theme/vscode-defaults.ts`; `packages/protocol/src/domain/theme.ts`.
- **Built-in Monokai, Solarized, Dark+ themes**: Theme definitions (copied; in `THIRD_PARTY_NOTICES.md`). Evidence: `packages/protocol/src/configuration/builtin-themes/monokai.ts`.
- **Tab strip**: Filled rail, 2px accent top border, close-button visibility, middle-click close, `fit` sizing, duplicate hint. Evidence: `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx`; `docs/adr/0002-unified-pane-layout.md`.
- **Tab drag and pane movement**: Hover-to-preview delay, drop overlay, grid neighbor navigation, next tab after close. Evidence: `apps/desktop/src/renderer/src/features/workbench/use-pane-tab-drag.ts`; `packages/protocol/src/domain/pane-layout-reducer.ts`.
- **Panel (Logs, Info) and `Cmd+J`**: Side Bar versus Panel split. Evidence: `apps/desktop/src/renderer/src/stores/chrome-layout.ts`; `packages/protocol/src/domain/default-keybindings.ts`.
- **Log viewer filter**: Output panel filter syntax. Evidence: `apps/desktop/src/renderer/src/features/panel/views/logs/log-filter.ts`.
- **Settings page**: Searchable virtual list, all-words search, modified marker. Evidence: `apps/desktop/src/renderer/src/features/settings/settings-page.tsx`; `settings-search.ts`.
- **Keyboard Shortcuts cheatsheet**: `Cmd+K Cmd+R` "Keyboard Shortcuts Reference" chord. Evidence: `packages/protocol/src/domain/default-keybindings.ts`.
- **Keybindings**: Chord syntax and capture; `Cmd+O`, `Cmd+K V`, `Cmd+K Cmd+W` (closes other tabs here, not all), `Cmd+0`; `sendSequence` newline rule. Evidence: `packages/protocol/src/configuration/shortcuts.ts`; `packages/protocol/src/domain/default-keybindings.ts`; `docs/keybindings.md`.
- **View container badges**: Badge priority and placement. Evidence: `DESIGN.md` (badges); `packages/protocol/src/domain/view-badges.ts`.
- **Status bar**: Corner bell; leading SSH remote indicator. Evidence: `apps/desktop/src/renderer/src/features/status-bar/status-bar.tsx`; `ssh-host-status.tsx`.
- **Side Bar section headers, scroll shadow, tree ARIA**: Caption style, `.shadow.top`, `aria-setsize`. Evidence: `docs/secondary-sidebar-trees.md`.
- **Files tree**: Sticky ancestors, active versus inactive selection, Git colors and letters. Evidence: `apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-tree.tsx`.
- **Source Control panel**: Default expansion, hover group actions, non-blocking refresh, Sync Changes, multi-diff, codicons. Evidence: `apps/desktop/src/renderer/src/features/view-containers/source-control/`; `apps/server/src/domains/git/working-tree.ts`.
- **Terminal command decorations, links, search toggles**: `terminalCommandDecoration` colors, local link order, link quick pick, modifier click, search chords. Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-command-tracker.ts`; `terminal-links.ts`; `terminal-search-bar.tsx`.
- **Terminal survives layout changes**: Reparenting a Terminal instead of disposing it. Evidence: `vscode.md`.
- **Session MRU switcher and navigation history**: Editor switcher without a scrim; capped history. Evidence: `apps/desktop/src/renderer/src/features/session/session-mru-switcher.tsx`; `session-navigation-history.ts`.
- **Open Session per window**: Per-window persisted state keyed by window, MRU-derived active window. Evidence: `docs/open-sessions.md`; `docs/adr/0017-per-window-session-presence.md`; `apps/server/src/domains/db/open-sessions.ts`.
- **Pickers and path browser**: Quick Pick without a scrim; subpath fallback; Quick Open focus restore. Evidence: `apps/desktop/src/renderer/src/components/ui/dialog.tsx`; `apps/desktop/src/main/path-browser-subpath.ts`.
- **Cmd+P recently opened files**: Editor history shown first in Quick Open under a "recently opened" separator, newest first, 200 entries per workspace, name-only matching with fuzzy ranking when filtering. Evidence: `docs/client-local-data.md`; `apps/desktop/src/renderer/src/features/editor/recent-files.ts`.
- **Confirmations; `caxri.window`; Extension API**: Modal copy rules, `vscode.window` shape, EventEmitter contract, inline tree actions. Evidence: `apps/desktop/src/renderer/src/stores/confirmations.ts`; `packages/extension-api/src/events.ts`; `tree-item-actions.ts`.
- **Markdown preview**: Separate engine and sanitizer, https images, preview links, preview to the side, scroll sync. Evidence: `docs/file-preview.md`; `packages/markdown/src/markdown-engine.ts`.
- **Editor defaults, breadcrumbs, tab descriptions**: Behaviors VS Code enables over Monaco's defaults. Evidence: `apps/desktop/src/renderer/src/lib/editor-options.ts`; `features/editor/editor-breadcrumbs-model.ts`.
- **Editor auto save**: `files.autoSave` setting name and `onFocusChange` semantics; saving a dirty editor on close without the Save/Don't Save prompt while auto save is on. Evidence: `packages/protocol/src/configuration/editor-settings-spec.ts`; `apps/desktop/src/renderer/src/features/editor/editor-auto-save-commands.ts`.
- **Duplicate Session title suffix**: Muted description after a tab label only when titles collide (VS Code editor tab descriptions); stable ordinal over dynamic disambiguation. Evidence: `apps/desktop/src/renderer/src/features/session/session-labels.ts`; `docs/open-sessions.md`.
- **`caxri` shell command install**: "Install 'code' command in PATH". Evidence: `docs/cli.md`; `apps/desktop/src/main/shell-command.ts`.
- **`argv.jsonc`, window zoom, GPU recovery gate**: `argv.json`, `window.zoomLevel` scale, boot flag gate. Evidence: `packages/protocol/src/desktop/argv-config.ts`; `apps/desktop/src/main/window-chrome.ts`; `gpu-recovery.ts`.
- **Window zoom indicator**: Status bar zoom entry shown only while the zoom differs from the default, opening Zoom Out, Zoom In, and Reset. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-indicator.tsx`.
- **File changes and symlinks**: Path-based change events and rename behavior. Evidence: `apps/server/src/domains/files/mutations.ts`; `listing.ts`.
- **Welcome and Add Project copy; Chinese UI style**: "Folder" wording; VS Code Simplified Chinese conventions. Evidence: `DESIGN.md` (welcome); `docs/i18n.md`.
- **File icons; codicons**: vscode-icons look; six vendored codicons (copied, CC BY 4.0). Evidence: `THIRD_PARTY_NOTICES.md`; `apps/desktop/src/renderer/src/icons/codicons/`; `licenses/VSCODE_CODICONS_LICENSE.txt`.
- **Agent environment from the interactive login shell**: Resolving a GUI launch's environment by running `$SHELL -i -l -c` and parsing the printed environment between markers. Evidence: `apps/server/src/domains/executables.ts` (`agentEnvironment`).
- **Editor hot exit**: Back up each dirty buffer about one second after typing pauses, keep its disk base for conflict detection, and restore it as unsaved on the next launch (`workingCopyBackupTracker`). Evidence: `apps/desktop/src/renderer/src/features/editor/editor-backups.ts`; `docs/client-local-data.md`.
- **Untitled editors**: `Untitled-N` naming that reuses the lowest free number, first-line tab names (40 characters), Save As suggesting the first line plus the detected extension, ML language detection with VS Code's model, threshold, and minimum length, and a save prompt on close and quit. Evidence: `apps/desktop/src/renderer/src/features/editor/untitled/names.ts`; `untitled/language-detection.ts`; `THIRD_PARTY_NOTICES.md`.
- **Shell command patterns**: `chat.tools.terminal.autoApprove` keys: a text key is a command prefix ending at a word boundary, `/regex/flags` keys are regular expressions, and each sub-command is checked on its own. Caxri's `agents.longRunningShellCommands` uses the same two forms, with Claude Code's `Bash(...)` wildcard added. Evidence: `packages/protocol/src/configuration/shell-command-patterns.ts`; `docs/activity-view.md`.
- **Reopen Closed Editor or Session**: `Cmd+Shift+T` reopens the most recently closed editor tab in its pane and index, repeats walk further back, entries that cannot reopen are skipped (VS Code Reopen Closed Editor, browser Reopen Closed Tab); Caxri adds archived Sessions to the same history. Evidence: `apps/desktop/src/renderer/src/features/closed-items/stack.ts`; `packages/protocol/src/domain/default-keybindings.ts`.
- **Session status rings turn in step**: Loading icons in one column share one rotation (`codicon-spin`); Caxri aligns each ring's CSS animation start to the document timeline's period boundary so staggered rings keep one phase. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/shared-spin-phase.ts`; `running-arc.tsx`.
- **Pending chord status hint**: After the first chord of a sequence a status hint names the armed chord and lists the available second keys, and the armed chord expires after 5 seconds (VS Code's chord timeout). Evidence: `apps/desktop/src/renderer/src/features/keyboard-shortcuts/pending-chord-store.ts`; `chord-hints.ts`.
- **Help menu entries**: Help leads with "Keyboard Shortcuts Reference" (`Cmd+K Cmd+R`), followed by Documentation, Release Notes, and Report an Issue items. Evidence: `apps/desktop/src/main/__tests__/menu.test.ts`; `docs/getting-started.md`.
- **Zen Mode**: `Cmd+K Z` hides every side bar, the Panel, tab bars, and the status bar as a temporary overlay that leaves the stored layout untouched, and revealing any surface leaves it (VS Code Zen Mode). Evidence: `apps/desktop/src/renderer/src/stores/chrome-layout.ts`; `packages/protocol/src/domain/default-keybindings.ts`.
- **Command palette Recently Used group**: A leading group of the last few run commands, newest first, before the full list. Evidence: `apps/desktop/src/renderer/src/features/palette/recent-commands.ts`.
- **Bundled extension strings as English-sentence keys**: `vscode.l10n` model where the English sentence is the catalog key and the Renderer translates it at display time. Evidence: `apps/desktop/src/renderer/src/features/view-containers/extension-text.ts`.

## GitLens (MIT, except `plus/` directories)

- **Commit history, avatars, hover cards, blame bar**: GitLens Git UX. Evidence: commit `3e48325b2`.
- **GitHub avatars; branch order**: Avatar lookup from author email; most recent commit first. Evidence: `extensions/git/src/github-avatar.ts`; `apps/server/src/domains/git/branches.ts`.

## vscode-fe-helper (MIT)

- **Status panel (Project Status)**: Sidebar model and polling scheduler. Evidence: `.agents/skills/competitors/SKILL.md`.
- **Unresolved review threads**: The "Unresolved Comments" group and its page size. Evidence: `apps/server/src/domains/project-status/review-threads.ts`.

## iTerm2

- **Tab chrome**: Accent hidden with one tab; tabs share width evenly; bar ends at "+". Evidence: `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx`; `features/workbench/pane-tab-bar.tsx`.
- **Splits and pane focus**: `Cmd+\` split; `Cmd+Option+Arrow` pane focus from inside a Terminal. Evidence: `packages/protocol/src/domain/default-keybindings.ts`.
- **Terminal title path shortening**: Path compression. Evidence: `packages/protocol/src/domain/terminal-title.ts`.
- **iTerm2 and Warp theme import**: File formats only. Evidence: `apps/server/src/domains/theme/theme-terminal-formats.ts`.

## Ghostty

- **Terminal keyboard handling**: Kitty keyboard protocol opt-in; `Cmd+C` without a selection reaches the app. Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-pane-xterm.ts`; `terminal-keyboard.ts`.
- **Modifier-only link click**: Link activation rule (with VS Code and iTerm2). Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-link-click-guard.ts`.
- **Oscura Midnight theme**: ANSI colors from the Ghostty port (copied; in `THIRD_PARTY_NOTICES.md`). Evidence: `packages/protocol/src/configuration/builtin-themes/oscura-midnight.ts`.

## Orca (MIT)

- **Terminal and Chat switch**: `Cmd+Shift+J` chord. Evidence: `packages/protocol/src/domain/default-keybindings.ts`; `orca.md`.
- **Mobile shared Terminal; tablet rule**: Desktop and phone observe one Terminal; width plus short-side tablet threshold. Evidence: `mobile-companions.md`; `apps/mobile/src/features/layout/layout-mode.ts`.
- **Activity glyphs**: State shown as a glyph instead of a word (with T3 Code). Evidence: `docs/activity-view.md`.
- **Session search**: FTS5 index with byte offsets and file identity; title, custom-title, ai-title order. Evidence: `docs/session-search.md`.
- **Session search speaker prefix**: Role label before a quoted message match. Evidence: `docs/session-search.md`.
- **Session creator ("Created by")**: A created workspace remembers its parent (worktree lineage). Evidence: `docs/agent-delegation.md`.
- **Background wait status**: A quiet monitoring sub-mode of running instead of a separate idle or done state. Evidence: `docs/activity-view.md`.
- **Chat image numbers**: `#N` badge on each attached thumbnail, matching the image's place in the message. Evidence: `docs/agent-chat.md`.
- **Usage chip weekly window name**: Compact `wk` (Chinese `本周`) instead of `7d`, which reads as days until reset. Evidence: `apps/desktop/src/renderer/src/lib/usage-format.ts`.
- **Chat video player**: Metadata-only preload until playback, and an unplayable state instead of a broken player. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/attachments/agent-chat-message-videos.tsx`.
- **Mobile computer status Session load**: Per-Session sum of PTY descendant CPU and memory; 2-second poll only while visible (also: Superset, cmux). Evidence: `apps/server/src/core/mobile/host-status.ts`; `apps/mobile/src/features/host-status/host-status-model.ts`.
- **PTY slot usage**: Machine-wide PTY use against the kernel limit, with per-process holders so the user can find what to close (Orca's Resource Manager "PTY manager"); Caxri adds the near-limit alert and the `pty_exhausted` launch reason. Evidence: `docs/process-explorer.md`.

## Wake (MIT)

- **Session search**: Cross-Agent discovery with one adapter per provider; trigram FTS5 with a short-term substring fallback; title hits ranked above content hits. Evidence: `docs/session-search.md`.
- **Session search lands on the match**: Opening a message match scrolls to and highlights the matched message. Evidence: `docs/session-search.md`.
- **Session search preview pane**: The selected result's matched message with its neighbours shown beside the list without opening it (also: Orca). Evidence: `docs/session-search.md`.

## agentsview (MIT)

- **Session search**: Appended JSONL resumed from a recorded byte offset instead of re-read. Evidence: `docs/session-search.md`.
- **Session search lands on the match**: Scroll to the matched message, then find with next and previous. Evidence: `docs/session-search.md`.

## T3 Code (MIT)

- **Activity queue placement and retention**: Left Side Bar queue (with the Codex app); 15-minute window. Evidence: `docs/activity-view.md`; `packages/protocol/src/domain/session/session-activity-group.ts`.
- **Chat composer card, Plan card, drafts**: Composer drawer and tray (with LobeHub), task badge, localStorage drafts. Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-drafts.ts`.
- **Open work-group shimmer**: The running turn's latest work group keeps its active sweep between calls, not only while one is in flight (`work-live` stays `active` after its command completes). Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-work-group.tsx`.
- **Side pane minimum width**: A 360px minimum for the pane beside the Chat, as for its right panel. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tasks/beside-chat-layout.ts`.
- **Long paste saved as a file**: 32 KiB threshold. Evidence: `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-contract.ts`.
- **Turn review, folding, work log**: Turn review and folding (with the Codex app). Evidence: `packages/protocol/src/agent/agent-chat-turn-fold.ts`; `apps/desktop/src/renderer/src/features/agent-chat/turns/agent-chat-turn-review-tab.tsx`.
- **Steered message fold segments**: Each message steered into a running turn starts its own fold and keeps its own last reply visible, timed per segment. Evidence: `packages/protocol/src/agent/agent-chat-turn-fold.ts`; `apps/mobile/src/features/agent-chat/agent-chat-timeline.ts`.
- **Mobile foreground recovery**: Probe or reconnect on return to foreground. Evidence: `docs/mobile/design.md`.
- **Streaming Markdown tests**: Prefix-equality tests. Evidence: `chat-markdown-rendering.md`.
- **Background wait status**: Background shells never hold a turn's completion; Caxri keeps that only for shells matching `agents.longRunningShellCommands`, and lets any other background shell hold it. Evidence: `docs/activity-view.md`.
- **Claude plan limits**: SDK `/usage` request plus `rate_limit_event` updates, no Keychain read. Evidence: `docs/usage.md`; `apps/server/src/domains/agent-chat/claude-plan-limits.ts`.
- **Caxri skill card**: A picked skill shown as a chip in the composer instead of typed text. Evidence: `docs/agent-chat.md`; `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-skill-card.tsx`.
- **Chat `@` file completion**: Workspace files offered from the composer's `@` trigger. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-file-mentions.ts`.
- **Agent Chat Session switch**: Frame-by-frame switch measurement; 16 remembered conversations; hidden Chats skip rendering their stream. Evidence: `docs/renderer-performance.md`; `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-cache-retention.ts`.
- **Chat message video tile**: A cited video shown as its poster frame with a centered play button and its name, opening a player on click. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/attachments/agent-chat-message-videos.tsx`.
- **Portable hand-off on a used-up provider**: When a provider's usage runs out, the workbench builds the continuation brief from the visible, budgeted conversation (failed or interrupted turns included) instead of asking the source model for a summary, and never copies reasoning or tool state. Evidence: `docs/agent-usage-continuation.md`; `apps/server/src/domains/agent-chat/continuation/continuation-brief.ts`.
- **SSH Host slow-link benchmark**: 3G link profile (400 kbps each way, 400 ms RTT) and reporting time beside bytes on the wire. Evidence: `scripts/ssh-link-benchmark.ts`; `docs/ssh-host.md` (Slow links).
- **Mobile computer status CPU**: Whole-machine CPU from the delta between two `os.cpus()` reads. Evidence: `packages/system/src/process/system-resources.ts`.
- **Claude process entrypoint label**: Overwriting `CLAUDE_CODE_ENTRYPOINT` with the client's own name on every Claude process it starts. Evidence: `apps/server/src/domains/agents/providers/claude/entrypoint.ts`.

## PandaCode (MIT with fork attribution)

- **Agent Chat streaming benchmark**: The workloads and readings of its published T3 Code comparison (a 50 KB streamed reply, 600 tool updates, Renderer work, memory growth while streaming, idle app memory). Evidence: `e2e/agent-chat-streaming.performance.e2e.ts`; `docs/renderer-performance.md`.
- **Character-bounded render caches**: A size budget beside the entry count for cached rendered markup. Evidence: `apps/desktop/src/renderer/src/lib/memo-cache.ts`.

## Paseo (Apache-2.0)

- **Activity group headings**: Glyph before each heading. Evidence: `docs/activity-view.md`.
- **Diff stat colors**: Green and red at equal lightness. Evidence: `packages/protocol/src/domain/diff-stat-colors.ts`.
- **Mobile read cache, image viewer, model sheet**: 50 cached messages per Chat; pinch, pan, double-tap viewer; bottom sheet. Evidence: `apps/mobile/src/features/read-cache/read-cache-model.ts`; `apps/mobile/src/features/agent-chat/agent-chat-image-viewer.tsx`.
- **Copy Resume Command**: Continue a conversation in another client (with Jean). Evidence: `paseo.md`; `jean.md`; `apps/desktop/src/renderer/src/features/terminal/terminal-surface-commands.ts`.
- **Agent Chat system-event visibility**: Explicit system-subtype handling keeps routine Hook diagnostics out of the conversation. Evidence: `docs/agent-chat.md`; `apps/server/src/domains/agent-chat/claude-system-notices.ts`.
- **Agent Chat feedback callouts**: Paseo notification severity uses an icon and a tinted container; Caxri preserves provider warning/error levels, source headings, and full readable details. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-message.tsx`; `apps/mobile/src/features/agent-chat/agent-chat-feedback.tsx`.
- **Window presence**: Client heartbeat of visible and focused state, used to decide what a user is looking at. Evidence: `docs/adr/0017-per-window-session-presence.md`; `apps/server/src/domains/window-presence/window-presence.ts`.
- **Consecutive reasoning as one thought**: A thought chunk appends to the previous thought instead of starting a new row. Evidence: `packages/protocol/src/agent/agent-chat-work.ts` (`mergeAgentChatReasoning`).

## Superset, Synara, Muxy, Herdr, Kero

- **Terminal and Chat toggle**: Always-visible segmented switch. Reference: Superset. Evidence: `superset.md`; `apps/desktop/src/renderer/src/features/terminal/agent-surface-toggle.tsx`.
- **Mobile composer submit**: Submit through the Terminal's Enter path. Reference: Superset. Evidence: `mobile-companions.md`; `docs/mobile/design.md`.
- **Composer mode chip; selection toolbar**: Glyph plus word chip; toolbar on pointer release. Reference: Synara (with Superset, LibreChat, assistant-ui). Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-add-menu.tsx`; `DESIGN.md` (selection toolbar).
- **Mobile Terminal take-over**: Explicit take-over, with the resize lease held on the Server. Reference: Muxy. Evidence: `mobile-companions.md`; `apps/mobile/src/features/terminal/lease-admission.ts`.
- **Visible delegation layout**: Sibling pane that keeps the caller's focus. Reference: Herdr. Evidence: `apps/server/src/domains/agent-delegation/layout.ts`; `herdr.md`.
- **Activity ranking**: Attention ranked above running work. Reference: Herdr, Kero. Evidence: `docs/activity-view.md`.
- **Terminal font loading**: Font cascade. Reference: Kero. Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-fonts.ts`.
- **Window presence**: Stable per-window key and per-client visible and focused tracking. Reference: Superset. Evidence: `docs/adr/0017-per-window-session-presence.md`; `apps/desktop/src/main/window-presence-registry.ts`.
- **Mobile computer status sort**: CPU and memory sort toggle for top processes; poll only while the view is visible. Reference: Superset (also cmux). Evidence: `apps/mobile/src/features/host-status/host-status-model.ts`.
- **Background work header**: A visible section label with its running count (`Background work 3`), and folded a one-line summary after it. Reference: Superset (work drawer; also Grok Build's `Tasks 3` dock and Claude Code's `3 background tasks`). Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/composer/strip/agent-chat-background-work-section.tsx`.
- **Ended background work row**: Ended tasks behind one quiet row at the foot of the list instead of a header control. Reference: Synara (also Claude Code's `Completed` group). Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/composer/strip/agent-chat-background-work-section.tsx`.

## LibreChat (MIT)

- **Pinned turn fold row**: An expanded activity group's header pins to the top of the transcript until its own rows end. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/turns/agent-chat-turn-fold.tsx` (`TurnFoldHeader`); `DESIGN.md` (turn fold).

## Streaming Markdown references

- **Streaming Markdown parser**: Re-parse only the tail with per-block reuse; count-based CI gate. Reference: Streamdown, LobeHub, assistant-ui. Evidence: `packages/markdown/src/streaming-parser.ts`; `chat-markdown-rendering.md`.

## LobeHub

- **Chat composer prompt history**: ArrowUp in an empty input opens a list of sent prompts, newest at the bottom, deduplicated, 50 rows; Enter fills without sending; placeholder preview. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-prompt-history.ts`.
- **Streaming reply pacing**: `useSmoothStreamContent`: reveal received text per animation frame at a rate that grows with the backlog, show a non-prefix rewrite at once, flush on finish. Evidence: `packages/protocol/src/agent/streaming/agent-chat-stream-pacing.ts`; `docs/agent-chat.md`.
- **Translucent primary sidebar**: Frosted-glass sidebar: the desktop blurs through a tinted sidebar while the main column stays opaque; a setting turns it off. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/translucent-sidebar.ts`.
- **Chat composer path pills**: A dragged file or folder shows inline as its file-type icon and name; the message keeps the absolute path. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-extensions.ts`.
- **Sidebar subagent rows**: Indented child rows under a Session (LobeHub thread rows, 32px inset) with a bounded list and expander. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/session-subagent-rows.tsx`; `docs/agent-chat.md`.
- **Chat user message images**: A sent message's images sit inside its bubble under the text, and an image-only message is still a bubble. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-user-message.tsx`.
- **Chat waiting popup**: `GlobalApprovalNotification` design only (code written independently): a top-center card below the title bar, one request at a time with an "N more" line, a fold to an "N pending" pill that unfolds on a new request, Chats on screen left out. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/waiting/agent-chat-waiting-popup.tsx`; `docs/agent-chat.md`.
- **Readable Chat beside a side pane**: `fitsBesidePortal`: a 420px floor for the conversation beside a Portal, and the working sidebar steps aside while the Portal is open. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tasks/beside-chat-layout.ts`; `docs/agent-chat.md`.
- **Chat turn spend in the composer strip**: `OpStatusTray`: steps, tokens, and price-list cost of the running turn behind icons, split by hairlines; zero hidden, steps above one; four decimals below a cent; only tokens when narrow; no stop hint. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/activity/agent-chat-turn-metric-list.tsx`; `docs/agent-chat.md`.
- **Chat reply speed and cost footer**: A finished reply's footer reads its generation speed and cost after the time (`62 tok/s`, then the cost behind a dollar glyph, as LobeHub puts its usage behind a coin glyph), with the totals on hover. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/activity/agent-chat-turn-metrics.ts` (`agentChatReplyMetrics`); `docs/agent-chat.md`.

## NumberFlow (MIT)

- **Rolling live figures in the Chat composer**: Digit roll with edge fades for a changing number, used as the `@number-flow/react` dependency for the running turn's elapsed time, steps, tokens, cost, and the context percentage. Evidence: `apps/desktop/src/renderer/src/components/animated-number.tsx`; `DESIGN.md` (Motion).

## Termany

- **One Session per window**: A Session belongs to one window (`PageClaims`, one page per window); opening it elsewhere focuses the owner (also: cmux, LobeHub `TopicPopupGuard`). Evidence: `docs/open-sessions.md`; `apps/server/src/domains/db/open-sessions.ts`.
- **Mobile computer status memory**: Used memory from `vm_stat` plus swap from `sysctl vm.swapusage` (approach only; AGPL code not copied). Evidence: `packages/system/src/process/system-resources.ts`.

## Codex app and Claude Code (closed or product references)

- **Chat Continue after a stopped or failed turn**: The empty composer's Send turns into a play button that continues the turn with one click, on Send's neutral `--foreground` circle with a 12px play glyph inside the 28px circle, matching the Codex app's proportions; Caxri sends a visible `Continue` message rather than the Codex app's empty turn. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/send/agent-chat-resume.ts`; `apps/desktop/src/renderer/src/features/agent-chat/composer/send/agent-chat-send-button.tsx`; `DESIGN.md` (Chat composer); `docs/agent-chat.md` (Pane).
- **Chat automatic continuation after a usage limit resets**: From Claude Code's `autoContinueAtUsageLimit` (which Agent SDK sessions do not get): the setting name, on by default, a 24-hour horizon, at most two waits after the first, and a prompt to pick up where it left off instead of resending the message; Codex continues with an empty turn as the Codex app's Continue does. Reference: Codex app, Claude Code. Evidence: `packages/protocol/src/agent/agent-usage-continuation.ts`; `apps/server/src/domains/agent-chat/codex-chat-session.ts`; `packages/protocol/src/configuration/agent-chat-settings-spec.ts`; `docs/agent-usage-continuation.md`.
- **Chat composer layout, 8px control radius**: `+` menu, Plan chip, model pill, round Send and Stop, effort popover; visual tokens. Reference: Codex app. Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/components/ui/button.tsx`.
- **Chat composer list continuation**: Shift+Enter in a list item starts the next item; on an empty item it ends the list; Enter still sends. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-list.ts`.
- **Chat composer live Markdown preview**: Markdown renders in place while typing; syntax returns where the caret touches it (Obsidian's live preview). Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-markdown.ts`.
- **Attachments and path references**: Tray layout; `# Files mentioned by the user:` format. Reference: Codex app. Evidence: `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-path-references.ts`.
- **Goal row, message times, conversation rail, turn changes card**: Layout and wording. Reference: Codex app. Evidence: `docs/agent-chat.md`; `apps/desktop/src/renderer/src/features/agent-chat/rail/agent-chat-message-rail.tsx`.
- **Conversation rail preview card**: Fixed-size card beside the tick with a title, a multi-line summary, and a corner badge, and a same-size title-plus-three-lines skeleton while content is not ready. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/rail/agent-chat-rail-preview-card.tsx`.
- **Chat selection actions (Copy, Add to message)**: Fade in where the toolbar lands, with no glide. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-selection-toolbar.tsx`.
- **Subagent wait and completion rows**: `<Name> finished` row named from the agent path instead of a bare `wait` tool. Reference: Codex app. Evidence: `packages/protocol/src/agent/agent-tool-presentation.ts`.
- **Shell command pattern wildcard**: `*` anywhere in a `Bash(...)` permission rule, matched per sub-command of a compound command. Reference: Claude Code. Evidence: `packages/protocol/src/configuration/shell-command-patterns.ts`.
- **Run a Chat reply's shell block**: A play button beside Copy on a reply's shell code block runs the command in a Terminal of the Session. Reference: Claude Code desktop app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/run-command/agent-chat-run-command.ts`; `docs/agent-chat.md` (Pane).
- **Sidebar subagent rows and hide toggle**: Nested subagent sessions under their parent, a vertical indent guide tying them to it, and a setting to hide them. Reference: Claude Code Desktop. Evidence: `docs/agent-chat.md`; `packages/protocol/src/configuration/primary-sidebar-settings-spec.ts`.
- **Transcript link underline**: No underline until hover (the color stays the full accent). Reference: Codex app. Evidence: `DESIGN.md` (Chat transcript); `apps/desktop/src/renderer/src/components/markdown/inline-nodes.tsx`.
- **MCP tool rows: server icon, tool title, connector glyph**: Icon from the server's `serverInfo.icons`, then a four-node connector glyph (redrawn, not copied); humanized tool title; summary glyph from the kind its calls share. Reference: Codex app. Evidence: `apps/server/src/domains/agent-chat/chat-mcp-servers.ts`; `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-mcp-glyph.tsx`.
- **Composer context ring**: A faint full track with an arc of the share used, not a filled pie. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/context/agent-chat-context-meter.tsx`; `DESIGN.md` (Chat composer).
- **Work row glyph set**: Open book for reads, connector glyph for MCP. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-work-group.tsx`.
- **Chat Jump to latest**: A round down-arrow button with no caption over the transcript. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-jump-to-latest.tsx`; `DESIGN.md` (Chat transcript).
- **Chat queued message rows**: Queue glyph, message, then always-shown labeled Steer, Edit, and Delete (Edit as its own icon rather than the Codex app's More menu, which would hold only it); no header while the queue simply waits. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-queue-list.tsx`; `DESIGN.md` (Chat composer).
- **Active work-group title**: Current tool action and target while the run is open, including between calls; aggregate once the run ends; chevron after the title and rows at the header's pitch. Reference: Codex app. Parallel calls: the newest still-running call's label (T3 Code's `latestRunningToolEntry`) plus a count of the others running (`and 2 more`), instead of Orca's per-kind present-tense counts. Evidence: `packages/protocol/src/agent/agent-chat-work.ts`; `DESIGN.md` (Agent Chat timeline).
- **Chat side chat (`/btw`, `Cmd+;`)**: Quick side question answered from the Chat's context beside the running turn, opened by `/btw <question>` or `Cmd+;`; no effect on the main conversation. Reference: Claude Code desktop app. Evidence: `docs/agent-chat.md` (Side chat); `packages/protocol/src/domain/default-keybindings.ts`.
- **Chat side chat pane and Convert to Session**: Follow-up thread in a pane beside the main conversation; a thread can be promoted to a conversation of its own. Reference: LobeHub (Portal Thread). Evidence: `docs/agent-chat.md` (Side chat).
- **Status panel Review group**: Review status and commit read from Codex's PR review summary comment. Reference: Codex. Evidence: `apps/server/src/domains/project-status/codex-review-summary.ts`; `docs/external-status-quota.md`.
- **Picker choice as the new-Chat default**: A model, effort, or Fast switch is written to `config.toml` through app-server `config/batchWrite` (`service_tier` spelled `fast` or `default`), as the TUI's picker persists it. Reference: Codex TUI. Evidence: `apps/server/src/domains/agent-chat/codex-models.ts`; `docs/agent-chat.md` (Fast mode).
- **A wait names the subagent it waits for**: one receiver reads `Waiting for <agent>`, several fall back to the plain phrase, as the TUI's `waiting_begin` titles a collab wait. Reference: Codex TUI (`codex-rs/tui/src/multi_agents.rs`). Evidence: `apps/server/src/domains/agent-chat/codex-items.ts`; `packages/protocol/src/agent/agent-tool-presentation.ts`; `docs/agent-chat.md` (Codex tasks).
- **Restore code, Fast mode, spinner verbs**: `/rewind` "Restore code"; `/fast`; spinner style. Reference: Claude Code. Evidence: `docs/agent-chat.md`; `DESIGN.md` (Chat status).
- **Editor selection Add to Chat**: A floating action over code selected in the editor that adds the selection's file and line range to the Agent conversation (Cursor's selection tooltip; VS Code Copilot's Add Selection to Chat; Claude Code's `@file#L5-L10` mention). Reference: Cursor, VS Code Copilot, Claude Code. Evidence: `apps/desktop/src/renderer/src/features/editor/editor-selection-toolbar.tsx`.
- **Chat inline image placeholders**: `[Image #N]` written where the image was pasted (the TUIs); drawn as an atomic inline pill with a thumbnail (Cursor's mentions). Reference: Claude Code, Codex, Cursor. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/attachments/agent-chat-image-placeholders.ts`.
- **Sidebar title edge fade**: About a character and a half of mask fade at the clipped edge; both edges stay faded while a hovered title scrolls. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`.overflow-fade`); `DESIGN.md` (Primary sidebar).
- **Transcript fade into floating chrome**: The transcript scrolls under Jump to latest and fades into the background instead of ending above the floating control. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/components/scroll-fade.tsx`; `DESIGN.md` (Scroll edge cues).
- **Sidebar compact `Show more` reveal**: The reveal under a windowed Session list is a content-width button whose label sits on the Session title edge, so its hover background never reads as a selected row. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/session-reveal-row.tsx`; `DESIGN.md` (Primary sidebar).
- **Sidebar detail card handoff**: Once one row's hover card is open, the next row's card replaces it at once with no exit fade, so sweeping the list swaps cards in place. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/sidebar-detail-card-handoff.ts`; `DESIGN.md` (Motion).
- **Chat composer draft stash**: Ctrl+S stashes the draft and Ctrl+S in an empty input restores it; the stash returns after the next send. Reference: Claude Code. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-draft-stash.ts`.
- **Chat slash menu recents**: A bare `/` leads with the commands and skills the user recently picked, as Claude Code's TUI ranks its `/` menu by its `skillUsage` history. Reference: Claude Code. Evidence: `packages/protocol/src/agent/agent-chat-commands.ts` (`agentChatRecentMenuActions`).
- **Chat composer Ctrl+C clear**: Ctrl+C empties a composer holding text or attachments; the text leaves as an edit, so Cmd+Z restores it. Reference: Claude Code. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-keys.ts`.
- **`Cmd+N` new Session**: Desktop app's `Cmd+N` new-conversation chord. Reference: Claude Code. Evidence: `packages/protocol/src/domain/default-keybindings.ts`.
- **Auto-archive after pull request merge or close**: The desktop app archives a Session once its pull request is merged or closed; the Session stays recoverable from the archive. Reference: Claude Code Desktop. Evidence: `apps/server/src/domains/pull-request/settlement.ts`; `docs/extensions.md`.
- **Needs-you context on a Session row and card**: The sidebar shows what a waiting Session asked, so the user decides whether to open it; Caxri quotes the pending question or last reply instead. Reference: Claude Code Desktop. Evidence: `apps/server/src/domains/agents/excerpts.ts`; `docs/activity-view.md`.
- **Idle Chat compaction**: Compact an idle conversation shortly before its one-hour prompt cache expires: 200K-token minimum, due at 90% of the cache lifetime, a setting to turn it off; the composer cache row and the Claude desktop app's idle notice show the countdown. Reference: Claude Code. Evidence: `packages/protocol/src/agent/agent-chat-usage.ts` (`agentChatIdleCompactionAt`); `docs/session-compaction.md`.
- **Transcript block actions and View Full Screen**: Hover-revealed copy on code, tables, and diagrams; expanding a block to a near-window dialog. Reference: ChatGPT, Claude.ai. Evidence: `DESIGN.md` (transcript blocks); `apps/desktop/src/renderer/src/components/markdown/block-fullscreen-dialog.tsx`.
- **Reply placeholder before the first token**: A figure under the just-sent message until the reply streams (three pulsing dots is one choice). Reference: ChatGPT, Claude.ai. Evidence: `DESIGN.md` (Agent Chat); `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-reply-placeholder.tsx`.
- **Chat live tool glyphs and Buddy**: A character glyph acting out each running tool (Grok's animated editing glyph); a mascot-style working figure (Claude's spark); a slanted sweep that rests between passes (Gemini's shimmer). Reference: Grok, Claude.ai, Gemini. Evidence: `DESIGN.md` (Motion); `apps/desktop/src/renderer/src/features/agent-chat/loading/loading.css`.
- **Zoom HUD**: Percentage pill with Zoom Out, Zoom In, and Reset at the top right after a zoom change, fading out. Reference: ChatGPT desktop. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-hud.tsx`.
- **Window zoom indicator**: A magnifier that stays in the address bar while the page is zoomed and opens a Zoom Out, Zoom In, and Reset bubble. Reference: Chrome. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-indicator.tsx`.
- **Chat status shimmer pacing**: `summary_shimmer.rs`: one linear sweep of about 1s in a 4s cycle, then a rest; Caxri's default sweeps linearly over 35% of 4000ms. Reference: Codex TUI. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`activity-dwell-shimmer`); `DESIGN.md` (motion).
- **Sidebar title overflow fade width**: A right-edge fade about one character (16px) wide, measured against Codex's sidebar. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`overflow-fade`).
- **Chat composer single status row**: One line holding the turn's verb, time, and spend, with plan and background work as collapsible sections above it instead of stacked cards or popovers. Reference: Codex app, Mux, Warp, VS Code. Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/activity/status-row/agent-chat-status-row.tsx`, `apps/desktop/src/renderer/src/features/agent-chat/composer/strip/agent-chat-strip-section.tsx`.
- **Chat return hint placement**: The unread jump shares the bottom corner with the scroll-down button, so the way back to what was missed sits near the composer and never overlaps Jump to latest. Reference: Telegram. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-return-hint.tsx`; `docs/activity-view.md` (Returning to a Session).
- **Enter steers a running turn**: While a turn runs, Enter steers the message into it for every provider and Cmd+Enter queues it for after the turn; the Codex app queues on Enter, and Caxri follows the CLIs instead. Reference: Codex CLI TUI (`submit_keys` Enter, `queue_keys` Tab, steer always on), Claude Code CLI (a mid-turn message is folded in once the current tool call returns). Evidence: `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-presentation.ts` (`agentChatSubmitDelivery`); `docs/agent-chat.md`.
- **Streaming reply fade-in**: Newly streamed characters fade in from transparent, so the reply's tail reads as a short gradient. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/components/markdown/revealing-text.tsx`; `DESIGN.md` (Motion).
- **Sidebar Fork Session and Session menu grouping**: A sidebar menu entry that forks the whole conversation into a new chat; a Copy submenu; Archive and Delete grouped last. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/session-row-menu.tsx`; `docs/agent-chat.md` (Fork Session).
- **Muted reasoning summary titles**: Bold summary titles keep the dimmed reasoning color instead of full contrast. Reference: Codex TUI. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tools/work-detail/agent-chat-work-detail.tsx`.

## CCLimitPing (MIT)

- **Scheduled Claude window warm-up**: Start a Claude subscription's 5-hour window with a minimal request at a chosen time so later resets land on a predictable schedule, driven by a per-user launchd job. Borrowed: the anchor-then-renew schedule and the launchd wake. Evidence: `apps/server/src/domains/claude-windows/schedule.ts`; `apps/desktop/src/main/claude-windows/launch-agent.ts`; `docs/claude-windows.md`.

## QuotaWarmer (no license; behavior reference only)

- **First workday reset as the setting**: The user picks when the first window of the day should reset, and the warm-up time is derived five hours earlier. Borrowed: the behavior only, no code. Evidence: `apps/desktop/src/renderer/src/features/settings/claude-windows/claude-windows-form.tsx`; `docs/claude-windows.md`.

## Chromium and LobeHub

- **Performance Monitor**: Chromium's "Frame Rate" HUD (fps, per-frame bars, GPU raster, GPU memory) and LobeHub's dev dock that reloads the window and times it. Evidence: `docs/performance-monitor.md`.

## monocode (MIT)

- **Worktree glyph**: A folder-tree icon (two folders joined by a tree line) for a linked worktree, replacing the VS Code `worktree` codicon. Evidence: `apps/desktop/src/renderer/src/features/status-bar/workbench-root-picker.tsx`.

## QuickTUI (closed product reference)

- **Mobile page preview**: Discover a local web server and preview it in the in-app browser (Port Forwarding). Evidence: `apps/mobile/src/features/browser/preview-chip.tsx`; `docs/mobile/preview.md`.

## Linear (closed product reference)

- **Chat code block folding**: A long fenced block folds to its first lines under a fade, with a centered `Expand (N lines)` pill and a `Collapse` pill below the expanded block. Evidence: `apps/desktop/src/renderer/src/components/markdown/code-collapse.ts`; `apps/desktop/src/renderer/src/components/markdown/code-collapse-toggle.tsx`; `DESIGN.md` (transcript blocks).

## prettier-plugin-jsdoc (MIT)

- **JSDoc text formatting rule**: `caxri/jsdoc-format` reproduces the plugin's 1.8.1 output for capitalization, whitespace collapse, 120-column wrapping, tag synonyms and order, Markdown lists, and embedded code. Borrowed: the formatting algorithm and tag tables, ported as code. Evidence: `scripts/eslint-rules/jsdoc-format/description.ts`; `scripts/eslint-rules/jsdoc-format/tags.ts`; `docs/quality-toolchain.md`; `THIRD_PARTY_NOTICES.md`.

## claude-code-four-o-three (MIT)

- **Environment baseline comparison**: Cache a prior egress reading and report a later change without assigning external-service meaning. Borrowed: the comparison model only, no code. Evidence: `apps/desktop/src/main/environment-monitor/monitor.ts`; `docs/notifications.md`.

## claude-env-check-skill (MIT)

- **Optional consistency signals**: Keep public IP as the minimal default and let users independently select additional observable environment signals. Borrowed: the layered signal model only, no code. Evidence: `packages/protocol/src/configuration/environment-monitor-settings-spec.ts`; `apps/desktop/src/main/environment-monitor/types.ts`.

## ipcheck (MIT)

- **Read-only environment diagnostics**: Present filtered findings without changing proxy or network configuration. Borrowed: read-only diagnostics only, no code. Evidence: `apps/desktop/src/main/environment-monitor/probe.ts`; `apps/desktop/src/renderer/src/features/status-bar/environment-monitor-chip.tsx`.

## CodexBar (MIT)

- **Claude extra usage left**: Read Claude's extra usage (`extra_usage`: enabled, monthly cap, spend in minor units) as what is left of the monthly cap. Borrowed: the field interpretation and the remainder figure. Evidence: `apps/server/src/domains/agent-chat/claude-plan-limits.ts`; `docs/agent-usage-continuation.md`.

## codex-reset.com (public API; credit required)

- **Codex global reset countdown**: Forecast data (the announcement's target time, text, and post URL) and its credit-plus-identifying-User-Agent reuse terms. Evidence: `packages/system/src/network/codex-global-reset.ts`; `docs/agent-throughput.md`.

## Dukou (closed product reference)

- **Share to a Session from the macOS Share menu**: Receiving files forwarded from WeChat ("Forward to other apps") through a share extension. Evidence: `docs/share-menu.md`.
