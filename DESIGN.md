# Caxri UI design spec

Authoritative visual/interaction spec for the workbench. Implementation work packages
reference this file; deviations require updating this spec first.

## Principles

1. **The terminal is the hero.** Chrome (sidebar, tabs, inspector, status bar) stays
   low-contrast and quiet; saturated color is reserved for content and live status.
2. **One accent focus per screen.** `--accent` marks exactly one thing at a time: the
   focused pane/tab. Everything else expresses state through foreground shades and
   background elevation, never through additional accent borders.
3. **No implementation vocabulary in the UI.** Users see "Settings", "Session",
   "Restart" — never "Runtime", "hot reload", "last-known-good", "bytes".
4. **Every color comes from a token.** Zero hardcoded hex in component CSS; themes are
   user-importable, so any literal color is a future light-theme bug.
5. **Tailwind v4 utilities over the semantic runtime tokens — and only those tokens.**
   The color roles below are bridged to Tailwind via `@theme inline`, so utilities like
   `bg-surface` resolve to the runtime theme variables and imported themes restyle the
   whole app live — the standard shadcn pattern. The default Tailwind palette is
   unregistered (`--color-*: initial`): `bg-blue-500` or arbitrary color literals must
   not compile, which makes rule 4 a build-time guarantee instead of a convention.
   Non-color scales (spacing, type, radius) use stock Tailwind defaults.

## Tokens

### Color roles (semantic layer over theme colors)

| Token                                  | Role                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `--background`                         | editor/terminal canvas                                                    |
| `--surface`                            | chrome: sidebar, tab strip, inspector, status bar                         |
| `--elevated`                           | hover states, cards, popovers                                             |
| `--border`                             | 1px hairlines between regions                                             |
| `--foreground`                         | primary text                                                              |
| `--muted`                              | secondary text, inactive icons                                            |
| `--accent`                             | the single focus indicator + primary buttons                              |
| `--accent-foreground`                  | text/icons on accent fills (derived, not hardcoded)                       |
| `--success` / `--warning` / `--danger` | status dots, exit banners, destructive buttons                            |
| `--overlay`                            | dialog backdrop: `color-mix(in srgb, var(--background) 60%, transparent)` |
| `--shadow`                             | elevation shadows: translucent black derived once                         |
| `--indicator`                          | neutral (non-accent) selected-tab underline for inspector/settings tabs   |

Derive `--accent-foreground`, `--overlay`, `--shadow` in one place from theme colors.
The status bar uses `--surface` + top hairline — never an accent fill.

### Type scale (root 13px)

| Tier    | Size | Usage                                             |
| ------- | ---- | ------------------------------------------------- |
| `title` | 15px | dialog titles and the welcome heading             |
| `base`  | 13px | default UI text, inputs, list rows                |
| `meta`  | 11px | secondary lines, captions, tab labels, status bar |
| `badge` | 10px | tiny badges/kbd hints only — never sentences      |

8px, 9px, and 10.5px sizes are banned. Monospace previews/diffs use `meta` size.

### Spacing and radius

- 4px grid: allowed gaps/paddings are 4, 8, 12, 16, 24. Row heights: 28px (dense list),
  36px (inputs/buttons md), 44px (palette input).
- Radius: 4px controls, 6px cards/list selection, 8px dialogs and palette. Nothing else.

## Component redlines

**Window chrome** — `titleBarStyle: 'hiddenInset'`; the 44px Sidebar, workbench, and Inspector
top rails share one bottom edge while their interactive tabs remain 36px high. The logo-free Sidebar
header is the drag region (`-webkit-app-region: drag`, interactive children `no-drag`); Add Project
is hidden at rest and revealed by hovering anywhere in the expanded Sidebar or by keyboard focus.
The collapsed Sidebar preserves the same 44px traffic-light drag clearance.

**Status bar** — `--surface` background, top hairline, `meta` text in `--muted`. The left side
shows Project and Git context. The right side follows the active tab: a normal file shows current-line
blame, selection, cursor position, and language; a Terminal shows its process-tree memory and child
count. Diff tabs show neither file nor Terminal details. Runtime state appears ONLY when degraded
(`Reconnecting…` / `Backend stopped`) as a `--warning`/`--danger` chip; healthy state shows nothing.
The chip is informational — recovery lives in the native Relaunch dialog, so the chip never fakes
an action it cannot perform.
Persistent metrics use concise icon-plus-value labels; explanatory prose belongs in their
accessible names and hover tooltips.

**Sidebar** — flatten the double-box nesting: project groups are a disclosure row
(Folder/FolderOpen icon + name + count, no border, no card), sessions are flat rows
indented 16px. Selection = `--elevated` fill (radius 6), no border and no accent — the
sidebar stays entirely neutral so the focused pane keeps the screen's one accent.
Activity dots keep color + gain `title`/`aria-label` text.
All non-archived Project and Session names and navigation icons use `--foreground`, including
inactive rows; the `--elevated` selected fill, not dimmed neighbors, communicates selection.
Project ordering uses the whole Project heading as its drag source. While dragging, dim only the
source group and show a 2px `--accent` insertion line with a circular leading cap between Project
groups; Session rows are never drop targets. `Option+Up` / `Option+Down` on a focused Project name
provides the keyboard-equivalent reorder and announces the resulting position.

**Tab strip** — active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, no accent underline (the pane's focus ring is the accent). Inactive:
`--surface` + `--muted`. Dirty dot replaces the close button until hover/focus (already
the pattern — keep). Tab height 36px.

**Git inspector** — every discovered repository is an independent disclosure node, with
its changed files grouped by directory. Selecting a file opens a read-only Monaco diff in
the center pane; the Inspector never embeds a patch preview. Each `Changes` heading exposes
`Open Changes`, which opens one scrollable multi-file diff tab for that repository.
The multi-file surface mounts Monaco only near the visible viewport and keeps an unreadable
or binary change isolated to its own row.

**Terminal panes** — focused pane keeps the accent inset ring (this IS the one accent). The xterm
viewport and scrollbar are full-bleed at the right edge; top/left text padding belongs to xterm's
content box so it never creates an outer scrollbar gutter.
Exit banner: keep current design; `--danger` text only for failures, `--muted` for clean
exits.

**Dialogs** — backdrop `--overlay` + `backdrop-filter: blur(2px)`; content radius 8,
border `--border`, shadow from `--shadow`. Never a close X inside the command palette.

**Command palette** — rows show command title left, `kbd` shortcut hint right (render
from live keybindings, `badge` size, `--elevated` chips). Group headings stay. Width 560px.

**Settings** — copy rewrite: dialog description becomes "Changes apply immediately and
are stored as editable files." Field labels in plain language; byte values rendered as
human units (`2 MB`) with unit-aware input. Every tab keeps a dirty marker; Apply saves
all dirty tabs. Compact scalar controls keep labels left and show their unit inside the field;
path controls occupy a full row. Provider launch groups use quiet `--elevated` sections headed by
the shared Agent identity icon, and every multiline value uses the same themed field/focus redline
as single-line input.

**Toasts** — three variants (`info`/`success`/`error`) with a 3px left bar in the status
color and matching icon; `info` uses `--muted` for its bar (an accent bar would be a
second accent). Error toasts persist until dismissed, others auto-dismiss 4s. Stack
bottom-right above the status bar, capped at three.

**Confirmations** — destructive commands (Delete Session, Delete Project) require a
native confirm dialog naming the target ("Delete session 'api-fix'? Files on disk are
not touched.").

## Interaction rules

- Global shortcuts never fire while focus is in an editable target (inputs, textarea,
  Monaco, xterm) unless the binding explicitly opts in (e.g. save).
- Every interactive element is keyboard-reachable; status conveyed by color always has
  a text/aria twin.
- Sidebar and inspector get min/max-constrained drag resize; double-click a divider resets to
  default. `Command+[` toggles the Sidebar and `Command+]` toggles the Inspector; the Status Bar
  contains no panel-collapse controls.
