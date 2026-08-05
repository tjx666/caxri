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

**Window chrome** — `titleBarStyle: 'hiddenInset'`; sidebar header becomes the drag
region (`-webkit-app-region: drag`, interactive children `no-drag`). Brand appears once:
sidebar header only. Reclaim the ~28px title bar row.

**Status bar** — `--surface` background, top hairline, `meta` text in `--muted`. Shows:
session root path (left), running-terminal count (right). Runtime state appears ONLY
when degraded (`Reconnecting…` / `Backend stopped`) as a `--warning`/`--danger` chip;
healthy state shows nothing. The chip is informational — recovery lives in the native
Relaunch dialog, so the chip never fakes an action it cannot perform.

**Sidebar** — flatten the double-box nesting: project groups are a disclosure row
(caret + name + count, no border, no card), sessions are flat rows indented 16px.
Selection = `--elevated` fill (radius 6), no border. The single accent use here: a 2px
left bar on the active session row only when the sidebar owns focus. Activity dots keep
color + gain `title`/`aria-label` text.

**Tab strip** — active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, no accent underline (the pane's focus ring is the accent). Inactive:
`--surface` + `--muted`. Dirty dot replaces the close button until hover/focus (already
the pattern — keep). Tab height 36px.

**Terminal panes** — focused pane keeps the accent inset ring (this IS the one accent).
Exit banner: keep current design; `--danger` text only for failures, `--muted` for clean
exits.

**Dialogs** — backdrop `--overlay` + `backdrop-filter: blur(2px)`; content radius 8,
border `--border`, shadow from `--shadow`. Never a close X inside the command palette.

**Command palette** — rows show command title left, `kbd` shortcut hint right (render
from live keybindings, `badge` size, `--elevated` chips). Group headings stay. Width 560px.

**Settings** — copy rewrite: dialog description becomes "Changes apply immediately and
are stored as editable files." Field labels in plain language; byte values rendered as
human units (`2 MB`) with unit-aware input. Every tab keeps a dirty marker; Apply saves
all dirty tabs.

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
- Sidebar and inspector get min/max-constrained drag resize; double-click a divider
  resets to default. Inspector is collapsible (status-bar toggle already exists).
