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
| `--merged`                             | landed work: the merged pull request glyph                                     |
| `--overlay`                            | dialog backdrop: `color-mix(in srgb, var(--background) 60%, transparent)`      |
| `--shadow`                             | elevation shadows: translucent black derived once                              |
| `--indicator`                          | neutral (non-accent) selected-tab underline for secondarySidebar/settings tabs |

Derive `--accent-foreground`, `--overlay`, and `--shadow` in one place from theme colors. The
status bar uses `--surface` plus a top hairline — never an accent fill.

`--merged` is a role rather than a reuse of `--success` because `--success` also identifies an open
pull request; sharing it left a landed PR and an open PR distinguishable
only by glyph shape at 13px. It is violet in every built-in theme, following the convention GitHub
established, and it is not `--accent`: two built-in palettes set `accent` to their own `success` or
`warning` value, so borrowing the focus token would simply recreate the collision. Being a status
role it is held to WCAG's 3:1 non-text floor on every chrome surface and to a 60° hue separation
from `success`, both asserted in `domains/__tests__/theme.test.ts`. A theme file saved before a color
role existed is repaired by `upgradeThemeColors` before validation, which recovers a saved preset's
own value from the catalog and falls back to a custom theme's `accent`. A fixed default hex is the
wrong tool here and was tried first: it silently downgraded every non-Dracula preset to `custom-*`
(`findMatchingBuiltinTheme` compares the whole snapshot) and no single violet clears the contrast
floor on both dark and light presets.

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
  padding while windowed. Both are horizontal clearance for the window controls; fullscreen hides
  those controls and omits the clearance. The 44px figure under Window chrome is rail height, a
  different axis.
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

**Path browser** — `Cmd+P` opens one 44px palette input with the current Project rendered as a
removable leading anchor. With an empty field and the caret at its start, Backspace or Delete removes
that anchor and turns the same control into a normal path field. Free-path mode accepts `~/`, `../`,
relative paths from the last browsed folder, and `/`-rooted absolute paths. Matching folders and files
remain visible below the field while the user types; Tab completes one unambiguous result, arrows move
through results, and Enter opens the selected result. This flow never opens a native folder picker.
Project-anchored mode retains Project-local create actions. Free-path mode is browse-and-open only: a
file inside the current Project still uses its normal editable Editor path, while an external file becomes
a read-only virtual Editor tab in the current Session, survives only for the Renderer lifetime, and never
creates a Project or Session or enters durable Session state.

**Status bar** — `--surface` background, top hairline, `meta` text in `--muted`. The left side
shows Project and Git context. The right side follows the active tab: a normal file shows
current-line blame, selection, cursor position, and language; a Terminal shows Terminal progress,
process-tree memory, and child count. Transient Agent operations stay with the owning work tab
instead of being duplicated here. Diff tabs show neither file nor Terminal details.
Caxri status appears ONLY when degraded (`Reconnecting…` / `Caxri stopped`) as a
`--warning`/`--danger` chip; healthy state shows nothing. The chip is informational — recovery
lives in the native Relaunch dialog, so the chip never fakes an action it cannot perform. The same
rule decides when a degraded chip becomes clickable: the Terminal's `DOM` renderer chip is a button
only while the fallback is the user's own GPU acceleration preference, which it offers to reverse
through a confirmation; every other fallback reason (WebGL unavailable, context lost, retrying)
stays a read-only reading because writing that preference again would change nothing.
Persistent metrics use concise icon-plus-value labels; explanatory prose belongs in their
accessible names and hover tooltips.

**PrimarySidebar** — flatten the double-box nesting: project groups are a disclosure row
(Folder/FolderOpen icon + name + count, no border, no card); sessions are flat rows indented 16px.
Selection is an `--elevated` fill (radius 6), no border and no accent — the primarySidebar stays
entirely neutral so the focused pane keeps the screen's one accent. Every Session row ends in one
fixed-width 14px status slot at the right edge. Show only one glyph: unread attention, running work,
or a detached Agent takes precedence over the pull request. The PR appears only when no lifecycle
signal is visible; its hover-card link, context-menu entry, and keyboard command remain available
while the row glyph is hidden. Keep the slot reserved even when empty, so titles never reflow and
all status glyphs share one vertical line. The MRU switcher likewise reserves its status slot to
stabilize the neighbouring relative timestamp. Unacknowledged attention wins and uses a warning ring/dot with a
ping; there is deliberately no second, static amber state, so reading a Session is the only thing
that clears the status and nothing can bring it back unread; active work (including compaction) uses
a muted spinner; settled, idle, unknown, failed, and exited Sessions render no status, which hands
the edge position to a pull request glyph. Thus a
failed process is not a persistent list alert, while reliable unread attention remains visible
regardless of its exact kind. Motion and shape carry the glance signal without changing title
weight, and the accessible label plus the Session hover/focus card preserve exact lifecycle and
attention details. On pointer hover, the Archive action replaces the track's trailing glyph in the
same position; keyboard focus keeps the track visible because Delete already owns the keyboard
action. The Portal
card opens to the PrimarySidebar's right after a short hover delay (or immediately on keyboard focus),
collision-shifts within the viewport, and shows only the full title, Project, primary Agent,
activity explanation, the pull request when one exists, the `Worktree` the Session works in when
that is not its own Project root, `Last opened`, and unread-attention metadata. All non-archived Project and
Session names and navigation icons use `--foreground`, including inactive rows. Clipped Session
names reveal their tail after a 600ms title hover or keyboard-focus pause, moving at a steady
reading speed and holding at the end. Leaving restores truncation; short names remain still.
Reduced motion keeps titles static, with the full name available in the detail card. The `--elevated`
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
history never fragments navigation. A disclosure renders its five most recently active Sessions
plus a `Show N more` row that reveals ten more per activation and disappears once the list is
complete, so a busy Project never buries the Projects below it. The selected Session always
renders even when it sits below that window, because Session order is activity recency rather than
visit history. The revealed count is per-Renderer-lifetime: a relaunch starts from the short list
the same way it starts scrolled to the top.

Pull request lifecycle owns the glyph color: open is `--success`, closed is `--danger`, merged
is `--merged`, and draft is `--muted`. Checks appear as text in the hover card, with failures in
`--danger`; never overlay a badge on the small PR glyph or recolor it for CI. The existing animated
yellow Session attention ring keeps its separate meaning and position.

The Status tab carries a compact, static numeric badge anchored to the heartbeat icon's lower-right
corner, following VS Code's activity-bar badge placement. Use a 14px minimum circular surface that
grows into a capsule for `9+`, `badge` text, `--danger`/`--danger-foreground`, and a surface-colored
ring separating it from the icon. It counts failed PR checks and current production/preview
deployments across the selected Session's repositories, deduplicated by identity. PR rollups,
historical deployments, pending work, and provider-fetch errors do not inflate the number. Zero or
unavailable status hides the badge; tooltip and accessible description expose the full count and
categories. Switching tabs does not clear failures; switching Sessions changes the badge scope.

**Tab strip** — active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, and a 2px `--accent` top border, VS Code style. Inactive: `--surface` +
`--muted`. Dirty dot replaces the close button until hover/focus (already the pattern — keep).
Tabs fill the full 44px rail height. Document tabs fit their full labels; Terminal tabs divide the
remaining width with an 80px minimum. Crowded bars scroll rather than imposing a fixed filename cap.
While the whole workbench holds exactly one tab across every
pane, that tab drops both the accent top border and the New Terminal button: an "active" marker
distinguishes nothing when there is nothing to distinguish it from, and the pane ring still
carries focus. The command stays reachable through `cmd+t` and the application menu, iTerm2 style.
Both return as soon as a second tab exists anywhere in the window. A clean preview Editor owns one
transient, Session-scoped motion identity: replacing its path updates the same DOM tab instantly,
pinning preserves that identity, and only the next real tab receives the existing enter animation.
An active ordinary file with committed history keeps two fixed ghost icon actions at the right of
its pane's tab rail: `Open Last Commit Changes` shows the latest commit that touched that file, and
`Open Pull Request Changes` shows the file's committed current-branch PR diff. They use distinct
commit and pull-request glyphs, remain keyboard reachable and outside the scroll rail, and hide for
Terminal, external, transcript, and Git diff tabs. These file actions remain when the Editor is the
only Workbench tab; the single-tab rule above still hides only New Terminal and the active accent.
Single-file Git diff tabs use the same action slot for `Previous Change`, `Next Change`, and
`Open Current File`. Navigation targets that pane's mounted diff and stays disabled until changes
are ready. Ordinary file and single-file diff tab menus offer `Copy Path` and `Copy Relative Path`;
relative paths use the containing repository, falling back to the Workbench Project for non-Git files.
Internal virtual tab identifiers are never copied as filesystem paths.
Session bootstrap and switching still mount without structural motion; actual close keeps the exit
animation. Transient Agent operations may temporarily use the existing text accessory after the
Terminal title and replace generic progress text while active. `Compacting` is the single
exception: it uses `--foreground` and a slow opacity pulse so long-running context compression
remains noticeable without animating the Agent icon or Session title. Work tabs carry no separate
process-state dot; process liveness remains available through diagnostics rather than duplicate
chrome. This does not govern the Session list's right-edge running spinner.

**Editor breadcrumbs** — an ordinary Project file gets one 24px metadata row below the tab strip.
Its Project-relative path sits on the left and the current file's last-change annotation sits on
the right; both use dense, muted chrome on `--surface`, separated from the editor by one hairline.
Only the file segment carries its file-type icon. Clicking any segment opens a flat sibling picker:
folders navigate one level at a time, files open in the Session's preview Editor, symbolic links are
visible but unavailable, and no symbol outline or settings are added. The path uses one keyboard tab
stop with Left/Right/Home/End navigation; Enter or Space opens the picker. The picker keeps one
listbox focus, supports arrows, Home/End, typeahead, Enter/Right to activate, Left for the parent,
and Escape to close. Long paths scroll horizontally without a visible scrollbar and keep the active
file in view; the last-change annotation truncates before the path becomes unusable.

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
   user-triggered section disclosure: PrimarySidebar Project, Files search groups, Git
   repository/history, Project Status sections. The measured SecondarySidebar/Settings
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
`--motion-overlay-exit` (100ms); `Compacting` pulses on `--motion-compaction-pulse` (1800ms,
ease-in-out). JS resolves tokens through `lib/motion.ts` (`motionDurationMs`);
settlement fallbacks are token plus a safety margin (`motionSettleTimeoutMs`), never an independent
literal.

Intentionally instant: initial bootstrap/restore, Session switches, tab-panel activation, Agent
state transitions, Project drag settlement, folder glyph changes, Terminal panes/output, data refreshes, and tree-item
disclosures in Files, Source Control, and extension-contributed trees. Do not stagger rows or neighboring tabs.
The Process Explorer window is out of scope (separate style layer, read-only diagnostics).

The Session status icon is the narrow state-motion exception: unread attention pings so a newly
actionable event is noticeable, and running spins. Amber always pings — an unread event is the only
thing that colors the slot — so a still amber dot never competes with it. The motion belongs inside
the icon; swapping among the three list projections remains instant.

The work-tab `Compacting` accessory is the other state-motion exception: only that word pulses,
while the Agent icon, Session title, focus accent, and neighboring tabs remain still. Hovered or
keyboard-focused clipped sidebar titles may scroll solely to reveal their text, as described above.

`prefers-reduced-motion: reduce` completes every layer instantly — overlay keyframes are gated
behind `motion-safe:` variants (the library ships no media query of its own, and a
`motion-reduce:animate-none` override would lose the specificity fight against the `data-open:`
attribute variant), disclosure CSS zeroes its durations, Session status icons keep their base shape
but stop moving, the `Compacting` word stays high-contrast and static, and Motion durations come
from the shared `useShouldReduceMotion` hook
(`hooks/use-should-reduce-motion.ts`, the only sanctioned way to read the preference in JS) —
without changing focus, selection, command, query, or lifecycle behavior.

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

**Project Status hover** — every row in the tree wears the same card, so one panel never mixes a
structured card with a multi-line grey string. The card follows the VS Code reference hierarchy:
the row's subject plus its semantic status in the heading, then prose that explains that heading,
then compact `label: value` rows. A repository names its branch and remote, a branch carries a
`default` badge, a deployment keeps `alias`, successful `inspect: logs`, and optional `created`, a
check carries its duration and `logs`, and a provider failure puts its recovery hint in the prose
line rather than forcing it into a list row. The row's own destination appears once, as the
trailing `link` row, and never a second time under a more specific label. A row with nothing
structured to add renders heading-only rather than falling back to the plain surface. The rich
hover uses the shared PreviewCard surface so its HTTP(S) links remain reachable by pointer and
keyboard; pointer opens capture the initial cursor position, place the card beside the cursor, and
flip it from right to left when necessary so the cursor's vertical path through adjacent rows
remains clear. Keyboard focus falls back to the row anchor, and viewport collision keeps the entire
card visible. Headings, prose, and values all wrap inside the bounded card instead of widening the
SecondarySidebar. The shared compact Tooltip surface, with the same cursor-side placement behavior,
remains correct for a genuinely single-line extension tooltip such as a Source Control file path.

An extension tree whose whole surface is unavailable uses one `message` item: a quiet, full-width
icon/title/description/action state built from the shared Empty primitive, never a long error forced
into a single data row. Missing prerequisites use a neutral icon and an action that rechecks the
state; actual failures use the matching status tone. The complete guidance stays visible without a
tooltip, and the item remains reachable through the tree's existing keyboard focus path.

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
unreadable or binary change isolated to its own row. `File History` is a top-level disclosure before
the repository nodes. It follows the active ordinary file, starts collapsed, and loads commits only
when opened; each commit opens that file's read-only diff directly. Terminal, diff, and out-of-scope
editors omit the disclosure entirely. Repository-scoped `Commits` stays nested under each repository
and keeps its optional path input and commit-details disclosure.

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
title with the live position on the right, Session rows (Agent identity icon, title over Project,
relative `Last opened`, then the same right-edge status indicator the PrimarySidebar renders), and
a footer of live `kbd` chips for cycle, reverse, cancel, and
release-to-commit. The highlighted row is the one place a list selection may carry `--accent` (an
inset ring over the `--elevated` fill): the surface exists only while its chord is held and its
whole purpose is to show where the pending jump lands, which is the transient action-scoped
carve-out in principle 2. Cycling scrolls the highlight into view; a pointer may highlight a row
by moving over it and commit it by clicking.

**Agent Actions picker** — `Command+Shift+A` opens an independent 560px picker only for a running
Agent Terminal. Its fixed target line names the provider, Session, and Terminal captured at open;
results are grouped as Commands and Skills and searchable without typing the `/` or `$` prefix.
`Enter` submits an argument-free action directly; `Command+Enter` appends the exact invocation plus
one space to the existing draft without submitting it. Actions with required arguments must first
be inserted and completed in the Terminal. The footer exposes both key meanings and a quiet
`Manage in Settings…` route. Selection or `Escape` returns focus to the captured Terminal. The
picker never reads, clears, or replaces the current Terminal draft.

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
matching icon; `info` uses `--muted` for its bar (an accent bar would be a second accent). Sonner
owns the queue, timers, keyboard access, and swipe dismissal. All three variants auto-dismiss after
4s of visible, non-interacting time; only explicit `persist` notices stay until dismissed. Stack
bottom-right above the status bar, with three visible cards. Hover or keyboard focus pauses expiry.
Use the close or action button to dismiss; clicking the message body does not dismiss it. Sonner's
internal transition/removal timing is a third-party exception to the motion token layers above;
its built-in reduced-motion media rule disables animation. Theme overrides live in `styles/styles.css`.

**Confirmations** — destructive commands (Delete Session, Delete Project) require a native confirm
dialog naming the target ("Delete session 'api-fix'? Files on disk are not touched."). Every other
"are you sure" moment uses the one in-app confirmation modal behind
`caxri.window.showConfirm({ title, message, confirmLabel, cancelLabel })` — a feature never mounts
its own. The title asks the question, the message names the consequence, the buttons name the
outcome ("Turn On", not "Yes"), the confirming button takes initial focus, and Escape, the close
button, and an outside click all mean Cancel. It carries no danger styling on purpose: anything
destructive enough to want it belongs in the native dialog above.

## Interaction rules

- `Option+click` on an existing tree or treegrid item disclosure target applies the clicked item's next state to that
  item and every descendant already known to the local tree model. Lazy trees never crawl unknown filesystem or
  extension branches for this gesture. Each tree keeps its existing row-versus-arrow activation behavior; section and
  Project disclosures are not tree items.
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
- **Bug Report annotation ink** — `screenshot-annotations.ts` hard-codes `#f43f5e` and `#ffffff`
  instead of theme tokens. The same color has to appear in the live SVG overlay and in the
  rasterized JPEG the Agent opens, and no token can repaint bytes already written to a file.
