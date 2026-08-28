# Caxri UI design spec

Authoritative visual and interaction spec for the workbench. Implementation work packages
reference this file; deviations require updating this spec first.

## Principles

1. **The terminal is the hero.** Chrome (primarySidebar, tabs, secondarySidebar, status bar) stays
   low-contrast and quiet. Saturated color is reserved for content and live status.
2. **One durable accent focus per screen.** `--accent` marks exactly one resting focus at a time:
   the focused pane together with its active workbench tab's 2px top border. The tab border and the
   pane ring express the same focus and count as one, VS Code style. The tab border drops out at a
   one-tab workbench, where it would mark a choice the user never has (see **Tab strip**), leaving
   the pane ring to carry focus alone. Primary buttons and transient, action-scoped feedback (the
   drag insertion line, drop-target tint) may also use `--accent` because they exist only for the
   duration of an interaction. Persistent chrome state expresses itself through foreground shades
   and background elevation, never through additional accent borders.
3. **No implementation vocabulary in the UI.** Users see "Settings", "Session", "Restart" — never
   "Runtime", "hot reload", "last-known-good", "bytes".
4. **Every color comes from a token.** Zero hardcoded hex in component CSS. Themes are
   user-importable, so any literal color is a future light-theme bug.
5. **Tailwind v4 utilities over the semantic runtime tokens — and only those tokens.** The color
   roles below are bridged to Tailwind via `@theme inline`, so utilities like `bg-surface` resolve
   to the runtime theme variables and imported themes restyle the whole app live — the standard
   shadcn pattern. The default Tailwind palette is unregistered (`--color-*: initial`): `bg-blue-500`
   or arbitrary color literals must not compile, which makes rule 4 a build-time guarantee instead
   of a convention. Non-color scales (spacing, type, radius) use stock Tailwind defaults.

`apps/desktop/src/renderer/src/styles/theme.css` is the single Tailwind/default-theme/bootstrap
source imported by both `styles.css` (main workbench) and `process-explorer.css`. Entry
files contain only their window-specific rules. `components.json` points shadcn at that shared
source. Its `baseColor: zinc` is immutable initialization metadata for the chosen shadcn style, not
a live palette: the shared `@theme` unregisters every default color and exposes only the semantic
roles below.

## Tokens

### Color roles (semantic layer over theme colors)

| Token                                  | Role                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `--background`                         | editor/terminal canvas                                                         |
| `--surface`                            | chrome: primarySidebar, tab strip, secondarySidebar, status bar                |
| `--elevated`                           | hover states, cards, popovers                                                  |
| `--border`                             | 1px hairlines between regions                                                  |
| `--foreground`                         | primary text                                                                   |
| `--muted`                              | secondary text, inactive icons                                                 |
| `--accent`                             | the single focus indicator + primary buttons                                   |
| `--accent-foreground`                  | text/icons on accent fills (derived, not hardcoded)                            |
| `--success` / `--warning` / `--danger` | status dots, exit banners, destructive buttons                                 |
| `--overlay`                            | dialog backdrop: `color-mix(in srgb, var(--background) 60%, transparent)`      |
| `--shadow`                             | elevation shadows: translucent black derived once                              |
| `--indicator`                          | neutral (non-accent) selected-tab underline for secondarySidebar/settings tabs |

Derive `--accent-foreground`, `--overlay`, and `--shadow` in one place from theme colors. The
status bar uses `--surface` plus a top hairline — never an accent fill.

`--muted` is secondary text, not a syntax comment color. It must clear WCAG AA (4.5:1) against
`--background`, `--surface`, and `--elevated` alike, and a theme is not free to borrow its
palette's comment color for it. The built-in palette is asserted against that floor in
`runtime/__tests__/theme.test.ts`, which also pins `styles/theme.css` to the same values so the
pre-Runtime first frame cannot drift. Imported themes are held to the same floor as a requirement:
app-color imports (full Caxri JSON and VS Code themes) are rejected before activation when
`--muted` misses the floor on any chrome surface, while terminal-only imports preserve the active
app and editor tokens.

### Type scale (root 13px)

| Tier    | Size | Usage                                                      |
| ------- | ---- | ---------------------------------------------------------- |
| `title` | 15px | dialog titles and the welcome heading                      |
| `base`  | 13px | default UI text, standard inputs, list rows                |
| `dense` | 12px | compact workbench fields, menus, tooltips, and path chrome |
| `meta`  | 11px | secondary lines, captions, tab labels, status bar          |
| `badge` | 10px | tiny badges/kbd hints only — never sentences               |

Sizes outside the tier table are banned. 8px, 9px, and 10.5px are called out explicitly because
they each shipped once as regressions. Monospace previews and diffs use `meta` size. Dense prose
may use unitless `1.45` or `1.5` line height; compact uppercase headings may use `0.04em` or
`0.06em` tracking. No other arbitrary typography values are allowed.

### Spacing and radius

- 4px grid: primary gaps and paddings are 4, 8, 12, 16, 24. Optical half-steps (2, 6, 10px) are
  allowed inside compact control chrome when a glyph or label does not center on the primary grid.
  Two grandfathered measurements predate the grid and are kept only to avoid chrome churn — the
  Status Bar's 5px item inset/gap and the shared panel caption's 3px top/bottom inset (preserving
  its 34px rail). Do not imitate them in new work. The panel divider's revealed hairline is 3px on
  whichever axis the seam runs — `w-[3px]` between columns, `h-[3px]` between rows — so the two
  orientations are the same seam, not two thicknesses. The macOS traffic-light clearance is the
  only platform spacing exception: 84px expanded-header and 78px collapsed-header/tab-strip left
  padding. Both are horizontal clearance for the window controls; the 44px figure under Window
  chrome is rail height, a different axis.
- Control heights: 24px compact inline rename/history, 28px dense workbench search, 36px standard
  Settings fields/buttons, and 44px palette/path input.
- Radius: 4px controls, 6px cards/list selection, 8px dialogs and palette. `rounded-full` is
  reserved for intrinsically circular shapes — activity dots, the drag insertion line's leading
  cap, and the Switch track/thumb (the one sanctioned fully-round control). No other radii.

`apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts` enforces the numeric
arbitrary-class allowlist above and rejects feature-local raw text inputs and raw checkboxes.
Boolean controls use the shared shadcn primitives: instant preferences render Switch, deliberate
pre-submit opt-ins render Checkbox, and label/description/control rows compose Field.
`input[type=color]` is the one remaining native input (the OS color picker has no shadcn
equivalent). Numeric arbitrary width/height constraints are also closed by default; the test's
small allowlist covers existing structural viewport, empty-state, and platform-diagnostic geometry,
not additional control-density tiers. Every allowlist entry is a grandfathered measurement, not a
precedent — a new arbitrary value requires updating this spec first with a stated reason.

## Component redlines

**Window chrome** — `titleBarStyle: 'hiddenInset'`. The 44px PrimarySidebar, workbench, and
SecondarySidebar top rails share one bottom edge. Workbench tabs fill the full 44px rail, VS Code
style, so the active tab's `--background` fill reaches the rail's top edge. PrimarySidebar and
SecondarySidebar rail tabs remain 36px, vertically centered. The logo-free PrimarySidebar header is
the drag region (`-webkit-app-region: drag`, interactive children `no-drag`). Add Project is hidden
at rest and revealed by hovering anywhere in the expanded PrimarySidebar or by keyboard focus. The
collapsed PrimarySidebar preserves the same 44px-tall drag region beneath the traffic lights.

**Welcome** — heading "Project-first development." Body copy uses "folder" to match VS Code's
Open Folder / Add Folder to Workspace, not "directory" or "local folder". The primary action is
Add Project.

**Status bar** — `--surface` background, top hairline, `meta` text in `--muted`. The left side
shows Project and Git context. The right side follows the active tab: a normal file shows
current-line blame, selection, cursor position, and language; a Terminal shows its transient Agent
operation, process-tree memory, and child count. Diff tabs show neither file nor Terminal details.
Caxri status appears ONLY when degraded (`Reconnecting…` / `Caxri stopped`) as a
`--warning`/`--danger` chip; healthy state shows nothing. The chip is informational — recovery
lives in the native Relaunch dialog, so the chip never fakes an action it cannot perform.
Persistent metrics use concise icon-plus-value labels; explanatory prose belongs in their
accessible names and hover tooltips.

**PrimarySidebar** — flatten the double-box nesting: project groups are a disclosure row
(Folder/FolderOpen icon + name + count, no border, no card); sessions are flat rows indented 16px.
Selection is an `--elevated` fill (radius 6), no border and no accent — the primarySidebar stays
entirely neutral so the focused pane keeps the screen's one accent. Activity dots and the Session
hover/focus card share one color, short-label, explanation, and `aria-label` mapping. Unread
attention is the one deliberate exception to that shared color: the unread ring and the card's
unread chip collapse every attention kind but `failed` to `--warning`, because a `--muted` unread
marker reads as inert chrome at glance distance. The activity dot on the same row still carries the
full state, and both surfaces keep the exact kind in their label. The Portal card opens to the
PrimarySidebar's right after a short hover delay (or immediately on keyboard focus),
collision-shifts within the viewport, and shows only the full title, Project, primary Agent,
activity explanation, `Last opened`, and unread-attention metadata. All non-archived Project and
Session names and navigation icons use `--foreground`, including inactive rows; the `--elevated`
selected fill, not dimmed neighbors, communicates selection. Project ordering uses the whole
Project heading as its drag source. While dragging, dim only the source group and show a 2px
`--accent` insertion line with a circular leading cap between Project groups; Session rows are
never drop targets. `Option+Up` / `Option+Down` on a focused Project name provides the
keyboard-equivalent reorder and announces the resulting position. The PrimarySidebar header
carries the Session history pair — Back then Forward, ghost icon buttons in `--muted` that lift to
`--foreground` on hover, placed immediately after the traffic-light clearance because that is
where every browser puts them. They are `no-drag` islands in the header's drag region. A direction
with an empty stack renders disabled rather than hidden, so the pair never reflows and its
position stays learnable; the shortcut and command name reach the user through the shared command
tooltip instead of a bespoke label. Archived Sessions use one stable PrimarySidebar footer entry
with a global count. Search, filters, Project-grouped results, restore, and delete live in a
full-width management dialog. Project disclosures contain active Sessions only, so low-frequency
history never fragments navigation.

**Tab strip** — active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, and a 2px `--accent` top border, VS Code style. Inactive: `--surface` +
`--muted`. Dirty dot replaces the close button until hover/focus (already the pattern — keep).
Tabs fill the full 44px rail height. While the whole workbench holds exactly one tab across every
pane, that tab drops both the accent top border and the New Terminal button: an "active" marker
distinguishes nothing when there is nothing to distinguish it from, and the pane ring still
carries focus. The command stays reachable through `cmd+t` and the application menu, iTerm2 style.
Both return as soon as a second tab exists anywhere in the window. A clean preview Editor owns one
transient, Session-scoped motion identity: replacing its path updates the same DOM tab instantly,
pinning preserves that identity, and only the next real tab receives the existing enter animation.
Session bootstrap and switching still mount without structural motion; actual close keeps the exit
animation. Transient Agent operations may temporarily use the existing text accessory before the
Terminal's process-state tail; they stay neutral, replace generic progress text while active, and
never animate.

**Motion** — motion explains structure; it never decorates state. Motion is a layered stack. Pick
the least-powerful layer that covers the scenario, and one element is only ever driven by one
layer:

1. **shadcn overlay layer** (`tw-animate-css` + animation classes in `components/ui/*`) — every
   overlay: dialogs, selects, context menus, tooltips, preview cards, and future shadcn
   components. Fade plus ~95% zoom on enter/exit, gated by Base UI popup state attributes. We
   deliberately do not import `shadcn/tailwind.css`: its custom `data-open`/`data-closed` variants
   exist to bridge Radix and Base UI, and this repo is Base UI–only, so native Tailwind attribute
   variants are equivalent (see upstream debate in shadcn-ui/ui#10267).
2. **Native CSS** (`interpolate-size: allow-keywords`, height `0 ↔ auto` transitions) — every
   user-triggered disclosure: PrimarySidebar Project, Files search groups, Git
   directory/repository/history, Project Status sections. The measured SecondarySidebar/Settings
   chrome tab indicator also uses a native transform/width transition.
   `components/disclosure-motion.tsx` is the thin presence wrapper: it mounts content in the
   commit that flips `data-expanded` and releases collapsed DOM once the height transition
   settles, so collapse never retains hidden queries, watchers, or large subtrees.
3. **auto-animate** (zero-config list add/remove/reorder) — deferred, not installed: its React
   StrictMode add-animation bug (formkit/auto-animate#232) is unfixed as of 0.10.0 and both
   renderer entries enable StrictMode. Until it lands, simple lists stay instant.
4. **Motion** (`motion/react` via `LazyMotion strict` + `motion/react-m`, `domAnimation` features
   only) — fine presence/timing control and future layout math: the work tab strip's enter/exit
   (opacity plus width), future drag reorder and shared-element transitions.

Timing lives in the `--motion-*` tokens in `styles.css` (`:root`) — the single source for CSS
transitions, tw-animate durations, Motion transitions, JS presence-cleanup fallbacks, and tests:
disclosures expand `--motion-expand` (180ms, `--motion-ease-emphasized`
`cubic-bezier(0.25, 1, 0.5, 1)`) and collapse `--motion-collapse` (130ms, ease-in); work tabs
enter `--motion-tab-enter` (140ms, ease-out) and exit `--motion-tab-exit` (110ms, ease-in); the
shared chrome tab indicator moves with `--motion-chrome-switch` (160ms,
`--motion-ease-emphasized`); overlays enter `--motion-overlay-enter` (150ms) and exit
`--motion-overlay-exit` (100ms). JS resolves tokens through `lib/motion.ts` (`motionDurationMs`);
settlement fallbacks are token plus a safety margin (`motionSettleTimeoutMs`), never an independent
literal.

Intentionally instant: initial bootstrap/restore, Session switches, tab-panel activation, Agent
activity, Project drag settlement, folder glyph changes, Terminal panes/output, data refreshes, and
asynchronously lazy-loaded expansion (the Files directory tree fetches children on expand — with
no content there is no spatial continuity to explain). Do not stagger rows or neighboring tabs.
The Process Explorer window is out of scope (separate style layer, read-only diagnostics).

`prefers-reduced-motion: reduce` completes every layer instantly — overlay keyframes are gated
behind `motion-safe:` variants (the library ships no media query of its own, and a
`motion-reduce:animate-none` override would lose the specificity fight against the `data-open:`
attribute variant), disclosure CSS zeroes its durations, Motion durations come from the shared
`usePrefersReducedMotion` hook (`lib/motion.ts`, the only sanctioned way to read the preference in
JS) — without changing focus, selection, command, query, or lifecycle behavior.

**Panel captions** — every SecondarySidebar panel wears the same caption row: 34px tall, bottom
hairline, and a small bold uppercase title with `tracking-[0.04em]` in `--foreground` (VS Code's
section caption). One shared `PanelHeader` owns it, so a Project name, `Source Control`, and
`Project Status` read as one system rather than three. The caption title carries no icon — the
owning tab already shows one two pixels above, and repeating it there is the duplication this rule
exists to prevent. Trailing toolbar actions may be hover-revealed, but only where the caption row
has free space; an action that would sit on top of live text takes its own slot instead.

**Content placement** — the SecondarySidebar holds hierarchical, navigable surfaces that read well
in a narrow vertical rail (Files, Source Control, Project Status). Stream- and record-shaped
surfaces that want horizontal room live in the Panel instead (Logs, Info), which docks under the
work surface inside the centre column so the PrimarySidebar and SecondarySidebar keep full height —
VS Code's PrimarySidebar-vs-Panel split. The Panel is closed at rest, its tabs sit left at their
natural width, and a trailing close button dismisses it. `Command+J` toggles it. A new surface
picks its region by content shape, not by which region has room left.

**Project Status deployment hover** — deployment rows follow the VS Code reference hierarchy:
target or environment plus semantic status in the heading, then compact `alias`, successful
`inspect: logs`, and optional `created` rows. The rich hover uses the shared PreviewCard surface so
its HTTP(S) links remain reachable by pointer and keyboard; pointer opens capture the initial cursor
position, keyboard focus falls back to the row anchor, and viewport collision keeps the entire card
visible. Text values wrap inside the bounded card instead of widening the SecondarySidebar. Plain
extension tooltips retain the shared compact Tooltip surface and cursor-placement behavior.

**Chrome tabs** — the moving underline is derived from the tab slot, never from the label inside
it: inset 8px on each side, capped, and centred in the slot. In the SecondarySidebar's evenly
divided rail every mark is therefore the same size, so it reads as "this region is selected"
instead of tracking a word whose length is incidental, and a responsive tab that drops its label
keeps its underline unchanged. The inset and the cap are what keep an even division from reading
as a segmented control — a mark that runs slot edge to slot edge on a 600px rail is a filled bar,
not an underline.

**Iconography** — an icon names what a thing _is_, never which mode a surrounding control is in. A
glyph reused for two meanings on one screen is a bug: the Git tab keeps the branch mark, so the
Source Control caption drops it, repository rows take a repository mark (`FolderGit2`, or the
vendored `file-submodule` codicon for a submodule) regardless of panel mode, and the mode switch's
working-tree segment takes a diff mark. Where lucide has no equivalent glyph, vendor the VS Code
codicon inline (`apps/desktop/src/renderer/src/icons/codicons`) rather than bending a lucide icon
to fit.

**Git secondarySidebar** — every discovered repository is an independent disclosure node, with its
changed files grouped by directory. Selecting a file opens a read-only Monaco diff in the center
pane; the SecondarySidebar never embeds a patch preview. The panel's mode switch offers Working
Tree, Last Commit, and Pull Request views; Last Commit renders the HEAD commit's file list and
hides `Open Changes` (no aggregated commit diff document exists). In the other modes each
`Changes` heading exposes `Open Changes`, which opens one scrollable multi-file diff tab for that
repository. The multi-file surface mounts Monaco only near the visible viewport and keeps an
unreadable or binary change isolated to its own row.

**Terminal panes** — the focused pane keeps the accent inset ring (with the active tab's top
border it forms the screen's one accent focus). The xterm viewport and scrollbar are full-bleed at
the right edge; top/left text padding belongs to xterm's content box so it never creates an outer
scrollbar gutter. Exited Terminals keep their final output and reserve a compact recovery row
beneath the xterm viewport, never over it. A zero exit without a signal is `--muted` / neutral
(`Process exited normally`); startup failures, signals, and non-zero exits use `--danger` text
and the matching human failure label. Surface actions, the command palette, and
`Command+Shift+R` restart the same durable Terminal record.

**Dialogs** — backdrop `--overlay` + `backdrop-filter: blur(2px)`; content radius 8, border
`--border`, shadow from `--shadow`. Never a close X inside the command palette.

**Command palette** — rows show command title left, `kbd` shortcut hint right (render from live
keybindings, `badge` size, `--elevated` chips). Group headings stay. Width 560px.

**Session switcher** — the hold-to-cycle MRU overlay (`Recently used Sessions`) is a modal moment
that ends on key release, so it wears the Dialog scrim (`--overlay` + `blur(2px)`) and the
palette's 560px width, centred. It reads top to bottom as caption / list / hint: a panel-caption
title with the live position on the right, Session rows (activity dot, Agent identity icon, title
over Project, relative `Last opened`, unread ring — the same indicator components the
PrimarySidebar renders), and a footer of live `kbd` chips for cycle, reverse, cancel, and
release-to-commit. The highlighted row is the one place a list selection may carry `--accent` (an
inset ring over the `--elevated` fill): the surface exists only while its chord is held and its
whole purpose is to show where the pending jump lands, which is the transient action-scoped
carve-out in principle 2. Cycling scrolls the highlight into view; a pointer may highlight a row
by moving over it and commit it by clicking.

**Agent Actions picker** — `Command+Shift+A` opens an independent 560px picker only for a running
Agent Terminal. Its fixed target line names the provider, Session, and Terminal captured at open;
results are grouped as Commands and Skills and searchable without typing the `/` or `$` prefix.
`Enter` appends the exact invocation plus one space to the existing draft without submitting it;
`Command+Enter` submits an argument-free action directly, while actions with required arguments
must first be inserted and completed in the Terminal. The footer exposes both key meanings and a
quiet `Manage in Settings…` route. Selection or `Escape` returns focus to the captured Terminal.
The picker never reads, clears, or replaces the current Terminal draft.

**Inputs** — shared `Input` density is always explicit outside standard forms: `standard` (36px,
base), `dense` (28px, dense), `compact` (24px, dense), or `palette` (44px, base). `appearance`
selects the standard themed fill, workbench canvas, inline surface, or an embedded field owned by
`InputGroup`; all variants share one border, focus ring, invalid, and disabled contract. Adorned
search/path fields use `InputGroup`, never feature-local field chrome.

**Settings** — dialog description: "Changes apply immediately and are stored as editable files."
Field labels in plain language; byte values rendered as human units (`2 MB`) with unit-aware
input. There is no Apply button and no per-tab dirty marker: a structured control writes as soon
as it changes, and the raw source editor commits when it loses focus, reporting a parse failure in
place instead of persisting it. A keybinding that collides with an existing chord is still written
and flagged inline on both rows — the editor reports conflicts, it never blocks the user out of
one. Compact scalar controls keep labels left and show their unit inside the field; path controls
occupy a full row. Settings and form rows compose the shared Field primitive (label left,
description under the label, control right); instant boolean preferences render Switch, and
clicking either the label or the control toggles it. Provider launch groups use quiet `--elevated`
sections headed by the shared Agent identity icon, and every multiline value uses the same themed
field/focus redline as single-line input.

**Toasts** — three variants (`info`/`success`/`error`) with a 3px left bar in the status color and
matching icon; `info` uses `--muted` for its bar (an accent bar would be a second accent). Error
toasts persist until dismissed, others auto-dismiss 4s. Stack bottom-right above the status bar,
capped at three.

**Confirmations** — destructive commands (Delete Session, Delete Project) require a native confirm
dialog naming the target ("Delete session 'api-fix'? Files on disk are not touched.").

## Interaction rules

- Global shortcuts never fire while focus is in an editable target (inputs, textarea, Monaco,
  xterm) unless the binding explicitly opts in (e.g. save or opening Agent Actions from its
  running xterm).
- Every interactive element is keyboard-reachable; status conveyed by color always has a text/aria
  twin.
- PrimarySidebar, SecondarySidebar, and Panel get min/max-constrained drag resize; double-click a
  divider resets to default. `Command+[` toggles the PrimarySidebar, `Command+]` toggles the
  SecondarySidebar, and `Command+J` toggles the Panel; the Status Bar contains no panel-collapse
  controls.
- Panel sizes and visibility are device-local (`localStorage`), never Session state, so a layout
  never travels between machines with a Project.
- Session history navigation (`Control+Option+Left` / `Control+Option+Right`, and the mouse's side
  buttons) is one of the deliberate opt-ins to the editable-target rule: switching Sessions is
  exactly what the user wants while an Agent Terminal holds focus. Its chords stay in the same
  `Control+Option` family as the MRU switcher so the whole Session-navigation set is one gesture
  family, and none of them shadow a Terminal control sequence.

## Known gaps

Acknowledged debt in the current spec. Entries here describe shipped reality, not an endorsement;
resolving one requires updating the sections above in the same change.

- **State tokens** — there is no `--hover` / `--selected` / `--active` layer, so components
  hand-roll `color-mix` recipes (status bar, project rows, process explorer, panel divider). Until
  dedicated state tokens land, reuse the closest existing recipe instead of inventing another
  formula.
- **Panel toggle shortcuts** — `Command+[` / `Command+]` collide with editor indent/navigate muscle
  memory and, per the global-shortcut rule, cannot fire while focus is in Monaco or xterm — where
  focus usually rests. Rebinding (e.g. `Command+B` for the PrimarySidebar) is an open product
  decision.
