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
- **Keybindings**: Chord syntax and capture; `Cmd+O`, `Cmd+K V`, `Cmd+0`; `sendSequence` newline rule. Evidence: `packages/protocol/src/configuration/shortcuts.ts`; `packages/protocol/src/domain/default-keybindings.ts`; `docs/keybindings.md`.
- **View container badges**: Badge priority and placement. Evidence: `DESIGN.md` (badges); `packages/protocol/src/domain/view-badges.ts`.
- **Status bar**: Corner bell; leading SSH remote indicator. Evidence: `apps/desktop/src/renderer/src/features/status-bar/status-bar.tsx`; `ssh-host-status.tsx`.
- **Side Bar section headers, scroll shadow, tree ARIA**: Caption style, `.shadow.top`, `aria-setsize`. Evidence: `docs/secondary-sidebar-trees.md`.
- **Files tree**: Sticky ancestors, active versus inactive selection, Git colors and letters. Evidence: `apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-tree.tsx`.
- **Source Control panel**: Default expansion, hover group actions, non-blocking refresh, Sync Changes, multi-diff, codicons. Evidence: `apps/desktop/src/renderer/src/features/view-containers/source-control/`; `apps/server/src/domains/git/working-tree.ts`.
- **Terminal command decorations, links, search toggles**: `terminalCommandDecoration` colors, local link order, link quick pick, modifier click, search chords. Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-command-tracker.ts`; `terminal-links.ts`; `terminal-search-bar.tsx`.
- **Terminal survives layout changes**: Reparenting a Terminal instead of disposing it. Evidence: `vscode.md`.
- **Session MRU switcher and navigation history**: Editor switcher without a scrim; capped history. Evidence: `apps/desktop/src/renderer/src/features/session/session-mru-switcher.tsx`; `session-navigation-history.ts`.
- **Open Session working set**: Per-window persisted editor working set, preview editor (a plain open replaces the one italic preview tab; double-click, edit, or an explicit open keeps it), MRU-derived active window. Evidence: `docs/open-sessions.md`; `docs/adr/0017-per-window-session-presence.md`; `apps/server/src/domains/db/open-sessions.ts`.
- **Session tab tear-off**: Drag a tab outside every window to open a new window: `dragend` with the native cursor as the fallback for a `0,0` point, window offset so the title bar sits under the cursor, clamped to the display, refused over the source window (also: cmux `moveWorkspaceToWindow`, LobeHub `TopicPopupGuard`). Evidence: `docs/open-sessions.md`; `apps/desktop/src/main/workbench-windows/tear-off.ts`; `apps/desktop/src/renderer/src/features/session-tabs/hooks/use-session-tab-drag.ts`.
- **Pickers and path browser**: Quick Pick without a scrim; subpath fallback; Quick Open focus restore. Evidence: `apps/desktop/src/renderer/src/components/ui/dialog.tsx`; `apps/desktop/src/main/path-browser-subpath.ts`.
- **Confirmations; `caxri.window`; Extension API**: Modal copy rules, `vscode.window` shape, EventEmitter contract, inline tree actions. Evidence: `apps/desktop/src/renderer/src/stores/confirmations.ts`; `packages/extension-api/src/events.ts`; `tree-item-actions.ts`.
- **Markdown preview**: Separate engine and sanitizer, https images, preview links, preview to the side, scroll sync. Evidence: `docs/file-preview.md`; `packages/markdown/src/markdown-engine.ts`.
- **Editor defaults, breadcrumbs, tab descriptions**: Behaviors VS Code enables over Monaco's defaults. Evidence: `apps/desktop/src/renderer/src/lib/editor-options.ts`; `features/editor/editor-breadcrumbs-model.ts`.
- **Duplicate Session title suffix**: Muted description after a tab label only when titles collide (VS Code editor tab descriptions); stable ordinal over dynamic disambiguation. Evidence: `apps/desktop/src/renderer/src/features/session/session-labels.ts`; `docs/open-sessions.md`.
- **Open Session tab placement and reveal**: New tabs open right of the active tab (`workbench.editor.openPositioning: right`); Reveal in Explorer from a tab; Open Editors marks what is open in the tree. Evidence: `docs/open-sessions.md`; `apps/desktop/src/renderer/src/features/session-tabs/`.
- **`caxri` shell command install**: "Install 'code' command in PATH". Evidence: `docs/cli.md`; `apps/desktop/src/main/shell-command.ts`.
- **`argv.jsonc`, window zoom, GPU recovery gate**: `argv.json`, `window.zoomLevel` scale, boot flag gate. Evidence: `packages/protocol/src/desktop/argv-config.ts`; `apps/desktop/src/main/window-chrome.ts`; `gpu-recovery.ts`.
- **Window zoom indicator**: Status bar zoom entry shown only while the zoom differs from the default, opening Zoom Out, Zoom In, and Reset. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-indicator.tsx`.
- **File changes and symlinks**: Path-based change events and rename behavior. Evidence: `apps/server/src/domains/files/mutations.ts`; `listing.ts`.
- **Welcome and Add Project copy; Chinese UI style**: "Folder" wording; VS Code Simplified Chinese conventions. Evidence: `DESIGN.md` (welcome); `docs/i18n.md`.
- **File icons; codicons**: vscode-icons look; six vendored codicons (copied, CC BY 4.0). Evidence: `THIRD_PARTY_NOTICES.md`; `apps/desktop/src/renderer/src/icons/codicons/`; `licenses/VSCODE_CODICONS_LICENSE.txt`.
- **Agent environment from the interactive login shell**: Resolving a GUI launch's environment by running `$SHELL -i -l -c` and parsing the printed environment between markers. Evidence: `apps/server/src/domains/executables.ts` (`agentEnvironment`).

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

## Wake (MIT)

- **Session search**: Cross-Agent discovery with one adapter per provider; trigram FTS5 with a short-term substring fallback; title hits ranked above content hits. Evidence: `docs/session-search.md`.
- **Session search lands on the match**: Opening a message match scrolls to and highlights the matched message. Evidence: `docs/session-search.md`.

## agentsview (MIT)

- **Session search**: Appended JSONL resumed from a recorded byte offset instead of re-read. Evidence: `docs/session-search.md`.
- **Session search lands on the match**: Scroll to the matched message, then find with next and previous. Evidence: `docs/session-search.md`.

## T3 Code (MIT)

- **Activity queue placement and retention**: Left Side Bar queue (with the Codex app); 15-minute window. Evidence: `docs/activity-view.md`; `packages/protocol/src/domain/session-activity-group.ts`.
- **Chat composer card, Plan card, drafts**: Composer drawer and tray (with LobeHub), task badge, localStorage drafts. Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-drafts.ts`.
- **Side pane minimum width**: A 360px minimum for the pane beside the Chat, as for its right panel. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tasks/beside-chat-layout.ts`.
- **Long paste saved as a file**: 32 KiB threshold. Evidence: `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-contract.ts`.
- **Turn review, folding, work log**: Turn review and folding (with the Codex app). Evidence: `packages/protocol/src/agent/agent-chat-turn-fold.ts`; `apps/desktop/src/renderer/src/features/agent-chat/turns/agent-chat-turn-review-tab.tsx`.
- **Mobile foreground recovery**: Probe or reconnect on return to foreground. Evidence: `docs/mobile/design.md`.
- **Streaming Markdown tests**: Prefix-equality tests. Evidence: `chat-markdown-rendering.md`.
- **Background wait status**: Background shells never hold a turn's completion. Evidence: `docs/activity-view.md`.
- **Claude plan limits**: SDK `/usage` request plus `rate_limit_event` updates, no Keychain read. Evidence: `docs/usage.md`; `apps/server/src/domains/agent-chat/claude-plan-limits.ts`.
- **Caxri skill card**: A picked skill shown as a chip in the composer instead of typed text. Evidence: `docs/agent-chat.md`; `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-skill-card.tsx`.
- **Chat `@` file completion**: Workspace files offered from the composer's `@` trigger. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-file-mentions.ts`.
- **Agent Chat Session switch**: Frame-by-frame switch measurement; 16 remembered conversations; hidden Chats skip rendering their stream. Evidence: `docs/renderer-performance.md`; `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-cache-retention.ts`.

## Paseo (Apache-2.0)

- **Activity group headings**: Glyph before each heading. Evidence: `docs/activity-view.md`.
- **Diff stat colors**: Green and red at equal lightness. Evidence: `packages/protocol/src/domain/diff-stat-colors.ts`.
- **Mobile read cache, image viewer, model sheet**: 50 cached messages per Chat; pinch, pan, double-tap viewer; bottom sheet. Evidence: `apps/mobile/src/features/read-cache/read-cache-model.ts`; `apps/mobile/src/features/agent-chat/agent-chat-image-viewer.tsx`.
- **Copy Resume Command**: Continue a conversation in another client (with Jean). Evidence: `paseo.md`; `jean.md`; `apps/desktop/src/renderer/src/features/terminal/terminal-surface-commands.ts`.
- **Agent Chat system-event visibility**: Explicit system-subtype handling keeps routine Hook diagnostics out of the conversation. Evidence: `docs/agent-chat.md`; `apps/server/src/domains/agent-chat/claude-system-notices.ts`.
- **Agent Chat feedback callouts**: Paseo notification severity uses an icon and a tinted container; Caxri preserves provider warning/error levels, source headings, and full readable details. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-message.tsx`; `apps/mobile/src/features/agent-chat/agent-chat-feedback.tsx`.
- **Window presence**: Client heartbeat of visible and focused state, used to decide what a user is looking at. Evidence: `docs/adr/0017-per-window-session-presence.md`; `apps/server/src/domains/window-presence/window-presence.ts`.

## Superset, Synara, Muxy, Herdr, Kero

- **Terminal and Chat toggle**: Always-visible segmented switch. Reference: Superset. Evidence: `superset.md`; `apps/desktop/src/renderer/src/features/terminal/agent-surface-toggle.tsx`.
- **Mobile composer submit**: Submit through the Terminal's Enter path. Reference: Superset. Evidence: `mobile-companions.md`; `docs/mobile/design.md`.
- **Composer mode chip; selection toolbar**: Glyph plus word chip; toolbar on pointer release. Reference: Synara (with Superset, LibreChat, assistant-ui). Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-add-menu.tsx`; `DESIGN.md` (selection toolbar).
- **Mobile Terminal take-over**: Explicit take-over, with the resize lease held on the Server. Reference: Muxy. Evidence: `mobile-companions.md`; `apps/mobile/src/features/terminal/lease-admission.ts`.
- **Visible delegation layout**: Sibling pane that keeps the caller's focus. Reference: Herdr. Evidence: `apps/server/src/domains/agent-delegation/layout.ts`; `herdr.md`.
- **Activity ranking**: Attention ranked above running work. Reference: Herdr, Kero. Evidence: `docs/activity-view.md`.
- **Terminal font loading**: Font cascade. Reference: Kero. Evidence: `apps/desktop/src/renderer/src/features/terminal/terminal-fonts.ts`.
- **Session tab trailing slot**: One fixed slot shared by the status glyph and the close button. Reference: Superset. Evidence: `DESIGN.md` (Two tab levels); `apps/desktop/src/renderer/src/features/session-tabs/session-tab.tsx`.
- **Window presence**: Stable per-window key and per-client visible and focused tracking. Reference: Superset. Evidence: `docs/adr/0017-per-window-session-presence.md`; `apps/desktop/src/main/window-presence-registry.ts`.

## Streaming Markdown references

- **Streaming Markdown parser**: Re-parse only the tail with per-block reuse; count-based CI gate. Reference: Streamdown, LobeHub, assistant-ui. Evidence: `packages/markdown/src/streaming-parser.ts`; `chat-markdown-rendering.md`.

## LobeHub

- **Chat composer prompt history**: ArrowUp in an empty input opens a list of sent prompts, newest at the bottom, deduplicated, 50 rows; Enter fills without sending; placeholder preview. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-prompt-history.ts`.
- **Streaming reply pacing**: `useSmoothStreamContent`: reveal received text per animation frame at a rate that grows with the backlog, show a non-prefix rewrite at once, flush on finish. Evidence: `packages/protocol/src/agent/agent-chat-stream-pacing.ts`; `docs/agent-chat.md`.
- **Translucent primary sidebar**: Frosted-glass sidebar: the desktop blurs through a tinted sidebar while the main column stays opaque; a setting turns it off. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/translucent-sidebar.ts`.
- **Chat composer path pills**: A dragged file or folder shows inline as its file-type icon and name; the message keeps the absolute path. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-extensions.ts`.
- **Session tab strip**: Hidden below two tabs; Open in New Tab alongside plain navigation. Evidence: `docs/open-sessions.md`; `apps/desktop/src/renderer/src/features/session-tabs/`.
- **Session tab strip look**: Inset neutral pill tabs on a short bar, active tab never narrower than 150px, short dividers hidden beside the active or hovered tab (also: Chrome, Cherry Studio). Evidence: `docs/open-sessions.md`; `DESIGN.md` "Two tab levels"; `apps/desktop/src/renderer/src/features/session-tabs/session-tab.tsx`.
- **Sidebar subagent rows**: Indented child rows under a Session (LobeHub thread rows, 32px inset) with a bounded list and expander. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/session-subagent-rows.tsx`; `docs/agent-chat.md`.
- **Chat user message images**: A sent message's images sit inside its bubble under the text, and an image-only message is still a bubble. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-user-message.tsx`.
- **Chat waiting popup**: `GlobalApprovalNotification` design only (code written independently): a top-center card below the title bar, one request at a time with an "N more" line, a fold to an "N pending" pill that unfolds on a new request, Chats on screen left out. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/waiting/agent-chat-waiting-popup.tsx`; `docs/agent-chat.md`.
- **Readable Chat beside a side pane**: `fitsBesidePortal`: a 420px floor for the conversation beside a Portal, and the working sidebar steps aside while the Portal is open. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tasks/beside-chat-layout.ts`; `docs/agent-chat.md`.
- **Chat turn spend in the composer strip**: `OpStatusTray`: steps, tokens, and price-list cost of the running turn behind icons, split by hairlines; zero hidden, steps above one; four decimals below a cent; only tokens when narrow; no stop hint. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/activity/agent-chat-turn-metric-list.tsx`; `docs/agent-chat.md`.

## NumberFlow (MIT)

- **Rolling live figures in the Chat composer**: Digit roll with edge fades for a changing number, used as the `@number-flow/react` dependency for the running turn's elapsed time, steps, tokens, cost, and the context percentage. Evidence: `apps/desktop/src/renderer/src/components/animated-number.tsx`; `DESIGN.md` (Motion).

## Termany

- **One Session per window**: A Session belongs to one window (`PageClaims`, one page per window); opening it elsewhere focuses the owner (also: cmux, LobeHub `TopicPopupGuard`). Evidence: `docs/open-sessions.md`; `apps/server/src/domains/db/open-sessions.ts`.

## Codex app and Claude Code (closed or product references)

- **Chat composer layout, 8px control radius**: `+` menu, Plan chip, model pill, round Send and Stop, effort popover; visual tokens. Reference: Codex app. Evidence: `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/components/ui/button.tsx`.
- **Chat composer list continuation**: Shift+Enter in a list item starts the next item; on an empty item it ends the list; Enter still sends. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-list.ts`.
- **Chat composer live Markdown preview**: Markdown renders in place while typing; syntax returns where the caret touches it (Obsidian's live preview). Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-markdown.ts`.
- **Attachments and path references**: Tray layout; `# Files mentioned by the user:` format. Reference: Codex app. Evidence: `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-path-references.ts`.
- **Goal row, message times, conversation rail, turn changes card**: Layout and wording. Reference: Codex app. Evidence: `docs/agent-chat.md`; `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-message-rail.tsx`.
- **Chat selection actions (Copy, Add to message)**: Fade in where the toolbar lands, with no glide. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-selection-toolbar.tsx`.
- **Subagent wait and completion rows**: `<Name> finished` row named from the agent path instead of a bare `wait` tool. Reference: Codex app. Evidence: `packages/protocol/src/agent/agent-tool-presentation.ts`.
- **Sidebar subagent rows and hide toggle**: Nested subagent sessions under their parent, a vertical indent guide tying them to it, and a setting to hide them. Reference: Claude Code Desktop. Evidence: `docs/agent-chat.md`; `packages/protocol/src/configuration/primary-sidebar-settings-spec.ts`.
- **Transcript link underline**: No underline until hover (the color stays the full accent). Reference: Codex app. Evidence: `DESIGN.md` (Chat transcript); `apps/desktop/src/renderer/src/components/markdown/inline-nodes.tsx`.
- **MCP tool rows: server icon, tool title, connector glyph**: Icon from the server's `serverInfo.icons`, then a four-node connector glyph (redrawn, not copied); humanized tool title; summary glyph from its first part. Reference: Codex app. Evidence: `apps/server/src/domains/agent-chat/chat-mcp-servers.ts`; `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-mcp-glyph.tsx`.
- **Work row glyph set**: Open book for reads, connector glyph for MCP. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/tools/agent-chat-work-group.tsx`.
- **Active work-group title**: Current tool action and target while running; aggregate after every item settles. Reference: Codex app. Evidence: `packages/protocol/src/agent/agent-chat-work.ts`; `DESIGN.md` (Agent Chat timeline).
- **Chat side chat (`/btw`, `Cmd+;`)**: Quick side question answered from the Chat's context beside the running turn, opened by `/btw <question>` or `Cmd+;`; no effect on the main conversation. Reference: Claude Code desktop app. Evidence: `docs/agent-chat.md` (Side chat); `packages/protocol/src/domain/default-keybindings.ts`.
- **Chat side chat pane and Convert to Session**: Follow-up thread in a pane beside the main conversation; a thread can be promoted to a conversation of its own. Reference: LobeHub (Portal Thread). Evidence: `docs/agent-chat.md` (Side chat).
- **Status panel Review group**: Review status and commit read from Codex's PR review summary comment. Reference: Codex. Evidence: `apps/server/src/domains/project-status/codex-review-summary.ts`; `docs/external-status-quota.md`.
- **Picker choice as the new-Chat default**: A model, effort, or Fast switch is written to `config.toml` through app-server `config/batchWrite` (`service_tier` spelled `fast` or `default`), as the TUI's picker persists it. Reference: Codex TUI. Evidence: `apps/server/src/domains/agent-chat/codex-models.ts`; `docs/agent-chat.md` (Fast mode).
- **A wait names the subagent it waits for**: one receiver reads `Waiting for <agent>`, several fall back to the plain phrase, as the TUI's `waiting_begin` titles a collab wait. Reference: Codex TUI (`codex-rs/tui/src/multi_agents.rs`). Evidence: `apps/server/src/domains/agent-chat/codex-items.ts`; `packages/protocol/src/agent/agent-tool-presentation.ts`; `docs/agent-chat.md` (Codex tasks).
- **Restore code, Fast mode, spinner verbs**: `/rewind` "Restore code"; `/fast`; spinner style. Reference: Claude Code. Evidence: `docs/agent-chat.md`; `DESIGN.md` (Chat status).
- **Chat inline image placeholders**: `[Image #N]` written where the image was pasted (the TUIs); drawn as an atomic inline pill with a thumbnail (Cursor's mentions). Reference: Claude Code, Codex, Cursor. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/attachments/agent-chat-image-placeholders.ts`.
- **Sidebar title edge fade**: About a character and a half of mask fade at the clipped edge; both edges stay faded while a hovered title scrolls. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`.overflow-fade`); `DESIGN.md` (Primary sidebar).
- **Chat composer draft stash**: Ctrl+S stashes the draft and Ctrl+S in an empty input restores it; the stash returns after the next send. Reference: Claude Code. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer-input/agent-chat-draft-stash.ts`.
- **Chat composer Ctrl+C clear**: Ctrl+C empties a composer holding text or attachments; the text leaves as an edit, so Cmd+Z restores it. Reference: Claude Code. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer-keys.ts`.
- **`Cmd+N` new Session**: Desktop app's `Cmd+N` new-conversation chord. Reference: Claude Code. Evidence: `packages/protocol/src/domain/default-keybindings.ts`.
- **Auto-archive after pull request merge or close**: The desktop app archives a Session once its pull request is merged or closed; the Session stays recoverable from the archive. Reference: Claude Code Desktop. Evidence: `apps/server/src/domains/pull-request/settlement.ts`; `docs/extensions.md`.
- **Needs-you context on a Session row and card**: The sidebar shows what a waiting Session asked, so the user decides whether to open it; Caxri quotes the pending question or last reply instead. Reference: Claude Code Desktop. Evidence: `apps/server/src/domains/agents/excerpts.ts`; `docs/activity-view.md`.
- **Transcript block actions and View Full Screen**: Hover-revealed copy on code, tables, and diagrams; expanding a block to a near-window dialog. Reference: ChatGPT, Claude.ai. Evidence: `DESIGN.md` (transcript blocks); `apps/desktop/src/renderer/src/components/markdown/block-fullscreen-dialog.tsx`.
- **Reply placeholder before the first token**: A figure under the just-sent message until the reply streams (three pulsing dots is one choice). Reference: ChatGPT, Claude.ai. Evidence: `DESIGN.md` (Agent Chat); `apps/desktop/src/renderer/src/features/agent-chat/messages/agent-chat-reply-placeholder.tsx`.
- **Chat live tool glyphs and Buddy**: A character glyph acting out each running tool (Grok's animated editing glyph); a mascot-style working figure (Claude's spark); a slanted sweep that rests between passes (Gemini's shimmer). Reference: Grok, Claude.ai, Gemini. Evidence: `DESIGN.md` (Motion); `apps/desktop/src/renderer/src/features/agent-chat/loading/loading.css`.
- **Zoom HUD**: Percentage pill with Zoom Out, Zoom In, and Reset at the top right after a zoom change, fading out. Reference: ChatGPT desktop. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-hud.tsx`.
- **Window zoom indicator**: A magnifier that stays in the address bar while the page is zoomed and opens a Zoom Out, Zoom In, and Reset bubble. Reference: Chrome. Evidence: `DESIGN.md` (Interface zoom); `apps/desktop/src/renderer/src/features/window-zoom/window-zoom-indicator.tsx`.
- **Chat status shimmer pacing**: `summary_shimmer.rs`: one linear sweep of about 1s in a 4s cycle, then a rest; Caxri's default sweeps linearly over 35% of 4000ms. Reference: Codex TUI. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`activity-dwell-shimmer`); `DESIGN.md` (motion).
- **Sidebar title overflow fade width**: A right-edge fade about one character (16px) wide, measured against Codex's sidebar. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/styles/styles.css` (`overflow-fade`).
- **Chat return hint placement**: The unread jump shares the bottom corner with the scroll-down button, so the way back to what was missed sits near the composer and never overlaps Jump to latest. Reference: Telegram. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-return-hint.tsx`; `docs/activity-view.md` (Returning to a Session).
- **Enter steers while the Agent waits on subagents**: While a Codex main Agent waits on its subagents, Enter steers the message into the running turn (ending the wait) instead of queueing it. Reference: Codex CLI TUI. Evidence: `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-presentation.ts` (`agentChatSubmitDelivery`); `docs/agent-chat.md`.
- **Streaming reply fade-in**: Newly streamed characters fade in from transparent, so the reply's tail reads as a short gradient. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/components/markdown/revealing-text.tsx`; `DESIGN.md` (Motion).
- **Sidebar Fork Session and Session menu grouping**: A sidebar menu entry that forks the whole conversation into a new chat; a Copy submenu; Archive and Delete grouped last. Reference: Codex app. Evidence: `apps/desktop/src/renderer/src/features/primary-sidebar/session-row-menu.tsx`; `docs/agent-chat.md` (Fork Session).
