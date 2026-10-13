# Feature references

Which external projects shaped which shipped Caxri features, and what was taken from each. Use it to
find the precedent a surface already follows before changing it, and to credit sources before a
public release. Per-product research lives in the sibling `<product>.md` notes; this file records
only adoption.

Rules for entries:

- Record an entry only with explicit evidence: a doc sentence, a code comment, or a commit message.
  Similarity alone is not evidence.
- "Borrowed" names the idea, interaction, value, or format taken. Copied code, assets, or text must
  also have a `THIRD_PARTY_NOTICES.md` entry; this file does not replace it.
- Evidence paths are repository-relative. Prefer the code comment or doc that states the precedent.
- Add the entry in the same change that ships the feature. Group it under its reference project,
  and add the project's section when it has none.

Seeded on 2026-10-13 from an evidence sweep of docs, code comments, and commit history.

## VS Code (MIT)

| Caxri feature                                       | Borrowed                                                                                                      | Evidence                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| VS Code theme import; tab, list, badge, Git roles   | Theme keys and registry default colors                                                                        | `DESIGN.md` (theme roles); `apps/server/src/domains/theme/vscode-defaults.ts`; `packages/protocol/src/domain/theme.ts`           |
| Built-in Monokai, Solarized, Dark+ themes           | Theme definitions (copied; in `THIRD_PARTY_NOTICES.md`)                                                       | `packages/protocol/src/configuration/builtin-themes/monokai.ts`                                                                  |
| Tab strip                                           | Filled rail, 2px accent top border, close-button visibility, middle-click close, `fit` sizing, duplicate hint | `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx`; `docs/adr/0002-unified-pane-layout.md`                               |
| Tab drag and pane movement                          | Hover-to-preview delay, drop overlay, grid neighbor navigation, next tab after close                          | `apps/desktop/src/renderer/src/features/workbench/use-pane-tab-drag.ts`; `packages/protocol/src/domain/pane-layout-reducer.ts`   |
| Panel (Logs, Info) and `Cmd+J`                      | Side Bar versus Panel split                                                                                   | `apps/desktop/src/renderer/src/stores/chrome-layout.ts`; `packages/protocol/src/domain/default-keybindings.ts`                   |
| Log viewer filter                                   | Output panel filter syntax                                                                                    | `apps/desktop/src/renderer/src/features/panel/views/logs/log-filter.ts`                                                          |
| Settings page                                       | Searchable virtual list, all-words search, modified marker                                                    | `apps/desktop/src/renderer/src/features/settings/settings-page.tsx`; `settings-search.ts`                                        |
| Keybindings                                         | Chord syntax and capture; `Cmd+O`, `Cmd+K V`, `Cmd+0`; `sendSequence` newline rule                            | `packages/protocol/src/configuration/shortcuts.ts`; `packages/protocol/src/domain/default-keybindings.ts`; `docs/keybindings.md` |
| View container badges                               | Badge priority and placement                                                                                  | `DESIGN.md` (badges); `packages/protocol/src/domain/view-badges.ts`                                                              |
| Status bar                                          | Corner bell; leading SSH remote indicator                                                                     | `apps/desktop/src/renderer/src/features/status-bar/status-bar.tsx`; `ssh-host-status.tsx`                                        |
| Side Bar section headers, scroll shadow, tree ARIA  | Caption style, `.shadow.top`, `aria-setsize`                                                                  | `docs/secondary-sidebar-trees.md`                                                                                                |
| Files tree                                          | Sticky ancestors, active versus inactive selection, Git colors and letters                                    | `apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-tree.tsx`                                         |
| Source Control panel                                | Default expansion, hover group actions, non-blocking refresh, Sync Changes, multi-diff, codicons              | `apps/desktop/src/renderer/src/features/view-containers/source-control/`; `apps/server/src/domains/git/working-tree.ts`          |
| Terminal command decorations, links, search toggles | `terminalCommandDecoration` colors, local link order, link quick pick, modifier click, search chords          | `apps/desktop/src/renderer/src/features/terminal/terminal-command-tracker.ts`; `terminal-links.ts`; `terminal-search-bar.tsx`    |
| Terminal survives layout changes                    | Reparenting a Terminal instead of disposing it                                                                | `vscode.md`                                                                                                                      |
| Session MRU switcher and navigation history         | Editor switcher without a scrim; capped history                                                               | `apps/desktop/src/renderer/src/features/session/session-mru-switcher.tsx`; `session-navigation-history.ts`                       |
| Pickers and path browser                            | Quick Pick without a scrim; subpath fallback; Quick Open focus restore                                        | `apps/desktop/src/renderer/src/components/ui/dialog.tsx`; `apps/desktop/src/main/path-browser-subpath.ts`                        |
| Confirmations; `caxri.window`; Extension API        | Modal copy rules, `vscode.window` shape, EventEmitter contract, inline tree actions                           | `apps/desktop/src/renderer/src/stores/confirmations.ts`; `packages/extension-api/src/events.ts`; `tree-item-actions.ts`          |
| Markdown preview                                    | Separate engine and sanitizer, https images, preview links, preview to the side, scroll sync                  | `docs/file-preview.md`; `packages/markdown/src/markdown-engine.ts`                                                               |
| Editor defaults, breadcrumbs, tab descriptions      | Behaviors VS Code enables over Monaco's defaults                                                              | `apps/desktop/src/renderer/src/lib/editor-options.ts`; `features/editor/editor-breadcrumbs-model.ts`                             |
| `caxri` shell command install                       | "Install 'code' command in PATH"                                                                              | `docs/cli.md`; `apps/desktop/src/main/shell-command.ts`                                                                          |
| `argv.jsonc`, window zoom, GPU recovery gate        | `argv.json`, `window.zoomLevel` scale, boot flag gate                                                         | `packages/protocol/src/desktop/argv-config.ts`; `apps/desktop/src/main/window-chrome.ts`; `gpu-recovery.ts`                      |
| File changes and symlinks                           | Path-based change events and rename behavior                                                                  | `apps/server/src/domains/files/mutations.ts`; `listing.ts`                                                                       |
| Welcome and Add Project copy; Chinese UI style      | "Folder" wording; VS Code Simplified Chinese conventions                                                      | `DESIGN.md` (welcome); `docs/i18n.md`                                                                                            |
| File icons; codicons                                | vscode-icons look; six vendored codicons (copied, CC BY 4.0)                                                  | `THIRD_PARTY_NOTICES.md`; `apps/desktop/src/renderer/src/icons/codicons/`; `licenses/VSCODE_CODICONS_LICENSE.txt`                |

## GitLens (MIT, except `plus/` directories)

| Caxri feature                                   | Borrowed                                                  | Evidence                                                                         |
| ----------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Commit history, avatars, hover cards, blame bar | GitLens Git UX                                            | commit `3e48325b2`                                                               |
| GitHub avatars; branch order                    | Avatar lookup from author email; most recent commit first | `extensions/git/src/github-avatar.ts`; `apps/server/src/domains/git/branches.ts` |

## vscode-fe-helper (MIT)

| Caxri feature                         | Borrowed                                          | Evidence                                                                                                                  |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Status panel (Project Status)         | Sidebar model and polling scheduler               | `.agents/skills/competitors/SKILL.md`                                                                                     |
| Unresolved review threads             | The "Unresolved Comments" group and its page size | `extensions/status/src/status-review-threads.ts`; `apps/server/src/domains/project-status/review-threads.ts`              |
| Linear status icons (Desktop, Mobile) | SVG glyphs (copied)                               | `apps/desktop/src/renderer/src/icons/linear/linear-status-icon.tsx`; `apps/mobile/src/features/panels/tree-item-icon.tsx` |

## iTerm2

| Caxri feature                  | Borrowed                                                             | Evidence                                                                                          |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tab chrome                     | Accent hidden with one tab; tabs share width evenly; bar ends at "+" | `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx`; `features/workbench/pane-tab-bar.tsx` |
| Splits and pane focus          | `Cmd+\` split; `Cmd+Option+Arrow` pane focus from inside a Terminal  | `packages/protocol/src/domain/default-keybindings.ts`                                             |
| Terminal title path shortening | Path compression                                                     | `packages/protocol/src/domain/terminal-title.ts`                                                  |
| iTerm2 and Warp theme import   | File formats only                                                    | `apps/server/src/domains/theme/theme-terminal-formats.ts`                                         |

## Ghostty

| Caxri feature              | Borrowed                                                                    | Evidence                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Terminal keyboard handling | Kitty keyboard protocol opt-in; `Cmd+C` without a selection reaches the app | `apps/desktop/src/renderer/src/features/terminal/terminal-pane-xterm.ts`; `terminal-keyboard.ts` |
| Modifier-only link click   | Link activation rule (with VS Code and iTerm2)                              | `apps/desktop/src/renderer/src/features/terminal/terminal-link-click-guard.ts`                   |
| Oscura Midnight theme      | ANSI colors from the Ghostty port (copied; in `THIRD_PARTY_NOTICES.md`)     | `packages/protocol/src/configuration/builtin-themes/oscura-midnight.ts`                          |

## Orca (MIT)

| Caxri feature                       | Borrowed                                                                            | Evidence                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Terminal and Chat switch            | `Cmd+Shift+J` chord                                                                 | `packages/protocol/src/domain/default-keybindings.ts`; `orca.md`         |
| Mobile shared Terminal; tablet rule | Desktop and phone observe one Terminal; width plus short-side tablet threshold      | `mobile-companions.md`; `apps/mobile/src/features/layout/layout-mode.ts` |
| Activity glyphs                     | State shown as a glyph instead of a word (with T3 Code)                             | `docs/activity-view.md`                                                  |
| Session search                      | FTS5 index with byte offsets and file identity; title, custom-title, ai-title order | `docs/session-search.md`                                                 |

## Wake (MIT)

| Caxri feature  | Borrowed                                                                                                                                     | Evidence                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Session search | Cross-Agent discovery with one adapter per provider; trigram FTS5 with a short-term substring fallback; title hits ranked above content hits | `docs/session-search.md` |

## agentsview (MIT)

| Caxri feature  | Borrowed                                                              | Evidence                 |
| -------------- | --------------------------------------------------------------------- | ------------------------ |
| Session search | Appended JSONL resumed from a recorded byte offset instead of re-read | `docs/session-search.md` |

## T3 Code (MIT)

| Caxri feature                                  | Borrowed                                                                                          | Evidence                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Activity queue placement and retention         | Left Side Bar queue (with the Codex app); 15-minute window                                        | `docs/activity-view.md`; `apps/desktop/src/renderer/src/features/agent-activity/agent-activity-retention.ts`                              |
| Chat composer card, Plan card, drafts, history | Composer drawer and tray (with LobeHub), task badge, localStorage drafts, `composerPromptHistory` | `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-drafts.ts`                                     |
| Long paste saved as a file                     | 32 KiB threshold                                                                                  | `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-contract.ts`                                                                |
| Turn review, folding, work log                 | Turn review and folding (with the Codex app)                                                      | `packages/protocol/src/agent/agent-chat-turn-fold.ts`; `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-turn-review-tab.tsx` |
| Mobile foreground recovery                     | Probe or reconnect on return to foreground                                                        | `docs/mobile/design.md`                                                                                                                   |
| Streaming Markdown tests                       | Prefix-equality tests                                                                             | `chat-markdown-rendering.md`                                                                                                              |

## Paseo (Apache-2.0)

| Caxri feature                                | Borrowed                                                                 | Evidence                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Activity group headings                      | Glyph before each heading                                                | `docs/activity-view.md`                                                                                                      |
| Diff stat colors                             | Green and red at equal lightness                                         | `packages/protocol/src/domain/diff-stat-colors.ts`                                                                           |
| Mobile read cache, image viewer, model sheet | 50 cached messages per Chat; pinch, pan, double-tap viewer; bottom sheet | `apps/mobile/src/features/read-cache/read-cache-model.ts`; `apps/mobile/src/features/agent-chat/agent-chat-image-viewer.tsx` |
| Copy Resume Command                          | Continue a conversation in another client (with Jean)                    | `paseo.md`; `jean.md`; `apps/desktop/src/renderer/src/features/terminal/terminal-surface-commands.ts`                        |

## Superset, Synara, Muxy, Herdr, Kero

| Caxri feature                         | Reference                                       | Borrowed                                                     | Evidence                                                                                                     |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Terminal and Chat toggle              | Superset                                        | Always-visible segmented switch                              | `superset.md`; `apps/desktop/src/renderer/src/features/terminal/agent-surface-toggle.tsx`                    |
| Mobile composer submit                | Superset                                        | Submit through the Terminal's Enter path                     | `mobile-companions.md`; `docs/mobile/design.md`                                                              |
| Composer mode chip; selection toolbar | Synara (with Superset, LibreChat, assistant-ui) | Glyph plus word chip; toolbar on pointer release             | `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-add-menu.tsx`; `DESIGN.md` (selection toolbar) |
| Mobile Terminal take-over             | Muxy                                            | Explicit take-over, with the resize lease held on the Server | `mobile-companions.md`; `apps/mobile/src/features/terminal/lease-admission.ts`                               |
| Visible delegation layout             | Herdr                                           | Sibling pane that keeps the caller's focus                   | `apps/server/src/domains/agent-delegation/layout.ts`; `herdr.md`                                             |
| Activity ranking                      | Herdr, Kero                                     | Attention ranked above running work                          | `docs/activity-view.md`                                                                                      |
| Terminal font loading                 | Kero                                            | Font cascade                                                 | `apps/desktop/src/renderer/src/features/terminal/terminal-fonts.ts`                                          |

## Streaming Markdown references

| Caxri feature             | Reference                         | Borrowed                                                         | Evidence                                                                            |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Streaming Markdown parser | Streamdown, LobeHub, assistant-ui | Re-parse only the tail with per-block reuse; count-based CI gate | `packages/markdown/src/streaming-parser.ts`; `chat-markdown-rendering.md`           |
| "Working" status phrases  | LobeHub                           | Phrase list (copied; license under review, no notice entry yet)  | `packages/protocol/src/agent/agent-chat-presentation.ts`; `DESIGN.md` (Chat status) |

## Codex app and Claude Code (closed or product references)

| Caxri feature                                                 | Reference   | Borrowed                                                                            | Evidence                                                                                              |
| ------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Chat composer layout, 8px control radius, Full access tint    | Codex app   | `+` menu, Plan chip, model pill, round Send and Stop, effort popover; visual tokens | `DESIGN.md` (Chat composer); `apps/desktop/src/renderer/src/components/ui/button.tsx`                 |
| Attachments and path references                               | Codex app   | Tray layout; `# Files mentioned by the user:` format                                | `docs/agent-chat.md`; `packages/protocol/src/agent/agent-chat-path-references.ts`                     |
| Goal row, message times, conversation rail, turn changes card | Codex app   | Layout and wording                                                                  | `docs/agent-chat.md`; `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-message-rail.tsx` |
| Chat selection actions (Copy, Add to message)                 | Codex app   | Fade in where the toolbar lands, with no glide                                      | `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-selection-toolbar.tsx`                  |
| Restore code, Fast mode, spinner verbs                        | Claude Code | `/rewind` "Restore code"; `/fast`; spinner style                                    | `docs/agent-chat.md`; `DESIGN.md` (Chat status)                                                       |
