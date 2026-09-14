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
   user-importable, so any literal color is a future light-theme bug. The one exception is a color an
   external system owns for its own content — a Linear workflow state, whose palette each workspace
   configures. Caxri's semantic roles cannot express someone else's palette, and quantizing it back
   to `success`/`warning` renders a state Linear shows green as yellow. Such a color arrives as data
   through a schema-validated `#RRGGBB` field, never as a literal in source, tints exactly one glyph's
   foreground, and is absent for every Caxri-owned icon, which inherits its row's theme color.
5. **Tailwind v4 utilities over the semantic runtime tokens — and only those tokens.** The color
   roles below are bridged to Tailwind via `@theme inline`, so utilities like `bg-surface` resolve
   to the runtime theme variables and imported themes restyle the whole app live — the standard
   shadcn pattern. The default Tailwind palette is unregistered (`--color-*: initial`), so
   `bg-blue-500` resolves to nothing. Unregistering does not reject it: Tailwind emits no rule and
   says nothing, and the class name ships on the element styling nothing, which is how the pairing
   QR code lost its white quiet zone. `caxri/registered-color-utilities` is what turns rule 4 into a
   check — a color utility whose token is absent from the `@theme inline` bridge is a lint error,
   including one that names a raw theme color such as `--selection`, which is referenced as
   `bg-[var(--selection)]` instead. Non-color scales (spacing, type, radius) use stock Tailwind
   defaults.
6. **Say each meaning once.** An icon, a reserved slot, or a control that already names a state
   does not also get an adjacent visual label repeating that state. Accessible names and tooltips
   stay complete — they are not the duplication this rule forbids. The Panel caption that omits the
   owning tab's icon is the same contract applied to a heading.
7. **Finish the likely action where it starts.** If the control or anchored picker already on
   screen can complete the next step, reuse it. Do not open a second list or a centered modal for a
   choice the first surface already has. Keep the next step next to the current pointer or focus.
8. **Keep recurring chrome geometrically stable.** Optional status that comes and goes occupies a
   reserved slot. An empty slot stays empty rather than collapsing, so neighbouring titles,
   timestamps, and actions do not shift. Encode the geometry, not a particular column index.
9. **Non-happy paths are product states.** Empty, loading, a missing prerequisite, and a failure
   each have honest copy, the matching semantic tone, and a recovery action the user can take. Do
   not render them as a blank surface, and do not relabel a failed probe as a successful negative
   (a Git error is not "not a repository").

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
| `--badge`                              | neutral view-container count badge fill                                        |
| `--badge-foreground`                   | text on `--badge` (derived, not hardcoded)                                     |
| `--git-added` … `--git-conflicting`    | working-tree decorations: added, modified, deleted, untracked, conflicting     |
| `--tab-*`                              | tab strip fill and label, per state: active, inactive, hover                   |
| `--list-*`                             | tree and list rows, per state: hover, focus, active/inactive selection         |
| `--title-bar-*`                        | window title bar fill and label, by whether the window is focused              |
| `--overlay`                            | dialog backdrop: `color-mix(in srgb, var(--background) 60%, transparent)`      |
| `--shadow`                             | elevation shadows: a theme value, read from `widget.shadow` on import          |
| `--indicator`                          | neutral (non-accent) selected-tab underline for secondarySidebar/settings tabs |

Derive `--accent-foreground`, `--danger-foreground`, `--badge-foreground`, and `--overlay` in one
place from theme colors. The status bar uses `--surface` plus a top hairline — never an accent fill.

Tabs, list rows, and the title bar own their states rather than borrowing a surface: eighteen
`--tab-*`, `--list-*`, and `--title-bar-*` tokens, plus `--shadow`, which became a theme value
instead of a derived one. Each reads one VS Code key on import — `tab.activeBackground`,
`list.hoverBackground`, `titleBar.activeBackground`, `widget.shadow`, and so on — and falls back to
the role that surface borrowed before, so a theme naming none of them looks exactly as it did. The
inactive list and title-bar states inherit from their active counterparts, which is VS Code's own
rule: a theme that styles only the focused state means the unfocused one to match. Alpha survives
the import, because `list.hoverBackground` is a translucent wash in most themes and flattening it
would paint an opaque band over the row instead of tinting it. An explicitly given color is never
rewritten just because it equals another role, and none of these states writes back into
`--background`, `--surface`, or `--elevated` — those three stay the canvas, the chrome, and the
popup fill. Read the decision on
[issue caxri#852](https://github.com/tjx666/caxri/issues/852#issuecomment-5656606135) for why each
key was chosen.

The two inactive title-bar roles need to know whether this window is the focused one, and CSS cannot
ask: `:window-inactive` is a WebKit pseudo-class and Chromium, which is what Electron runs, has no
equivalent. `lib/window-active.ts` publishes the condition as `data-window-active` on the same
`<html>` element the color variables land on, and `styles/theme.css` defines a `window-inactive:`
variant over it, so every surface that paints a title bar switches together.

A built-in preset fills these roles from its upstream theme only where that clears the contrast
floor. Every label the focused window shows — the three tab states, the four list states, and
`titleBarActiveForeground` — must reach WCAG AA on its own fill, asserted per theme and per role in
`domains/__tests__/theme-control-colors.test.ts`. This is the same rule `--muted` already answers
to, and for the same reason: several upstream themes set `tab.inactiveForeground` to their comment
color, which is exactly the substitution that rule forbids. A preset is Caxri's own product, so it
takes the correction; an imported theme is its author's and keeps the original values.
`titleBarInactiveForeground` is the one exemption. It paints only while the whole window is
unfocused — inactive UI under WCAG 1.4.3, and the one case where the dimming is the message, which
is how macOS and VS Code both fade an unfocused title.

A preset must also leave the active tab distinguishable from its neighbours by fill or by label,
because the accent line above an active tab is drawn only on the focused pane and the other pane in
a split has nothing else to go on. A theme that paints both tab states one color has to give the
difference back somewhere, since the contrast floor above is what pulls the two labels together.

`--badge` and the five `--git-*` roles exist so the theme, not the component, decides these colors.
Both mirror a VS Code key a theme author already writes — `activityBarBadge.background` and the Git
extension's `gitDecoration.*ResourceForeground` — so a built-in preset carries the exact value VS
Code would paint, and a VS Code theme import reads them straight across. Before them the count badge
was hardcoded `--foreground` on `--background` (white in every dark theme, where VS Code shows the
theme's own badge color) and the status letters borrowed `--success`/`--warning`/`--danger`, which
collapses added and untracked onto one color and paints a modified file the same amber as a warning
chip. `renamed` deliberately has no role of its own: VS Code's two defaults resolve to the same
green, so it shares `--git-untracked`; ignored entries stay on `--muted`. A theme file saved before
these roles existed is repaired by `upgradeThemeColors` the same way `--merged` is.

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
the drag region (`-webkit-app-region: drag`, interactive children `no-drag`). The Session history
back/forward pair is the only control that rail carries, and it opts out of the drag region so the
buttons navigate instead of moving the window. Add Project has no chrome of its own there: its entry
points are `Cmd+O` (which works from a focused Terminal or editor too), the native Project menu, the
command palette, and the Welcome view's primary action while no Project exists. A workbench-wide
action that a shortcut, a menu, and the palette all reach does not also earn a hover-revealed button
in a 44px rail. The collapsed PrimarySidebar preserves the same 44px-tall drag region beneath the
traffic lights.

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
when GPU acceleration is disabled or a failure has settled. Confirmation either enables acceleration
in Settings or retries the current Terminal's GPU renderer without changing settings or restarting
the Terminal. An explicit retry resets the window's GPU incident budget; subsequent failures still
use the normal limits. Automatic recovery in progress stays informational to avoid duplicate retries.
Persistent metrics use concise icon-plus-value labels; explanatory prose belongs in their
accessible names and hover tooltips. The notification bell is pinned to the far bottom-right corner,
outside the right-hand chip rail, VS Code style: every chip beside it follows the active tab and
comes and goes as the user moves around, so an anchor placed among them would slide sideways, and
the rail's last child is the first thing an overflow hides.

The Workbench Root picker shows branch labels on one line, with directory hints only for detached
or duplicate branch labels and complete paths in shared tooltips. Its compact list pins the current
root, includes the five newest other linked roots, and keeps the Git main worktree reachable with
a `Main worktree` marker. `Show all worktrees…` expands the same popover into a searchable list.
Unknown creation times sort last, deterministically. An `Authorize` label distinguishes discovered
but unapproved roots; selecting one opens the shared in-app confirmation with its full destination
and `Authorize and switch`. Cancel grants nothing. Approved roots switch directly without Finder.

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
card opens to the PrimarySidebar's right after a short hover delay (or immediately on intentional keyboard focus),
collision-shifts within the viewport, and shows only the full title, Project, primary Agent,
activity explanation, the pull request when one exists, the `Worktree` the Session works in when
that is not its own Project root, `Last opened`, and unread-attention metadata. Opening a modal closes
the card and gives the modal ownership of Escape. Canceling a picker restores the exact opening
control without reopening its detail card; a command's explicit focus handoff takes precedence.
If the opening control disappeared, restore the current workbench Terminal when available.
All non-archived Project and
Session names and navigation icons use `--foreground`, including inactive rows. Clipped Session
names reveal their tail after a 600ms title hover or keyboard-focus pause, moving at a steady
reading speed and holding at the end. Leaving restores truncation; short names remain still.
Reduced motion keeps titles static, with the full name available in the detail card. The `--elevated`
selected fill, not dimmed neighbors, communicates selection. Project ordering uses the whole
Project heading as its drag source. While dragging, dim only the source group and show a 2px
`--accent` insertion line with a circular leading cap between Project groups; Session rows are
never Project drop targets. Sessions can be dragged within their owning Project, using a 2px
`--accent` insertion line and dimming only the dragged row. Dragging freezes the visible Session
sequence until the move settles; status updates continue. A move changes only the explicit sidebar
position. New Sessions and meaningful activity promote the affected Session to the top without
resorting its neighbors. Visits and streamed output never promote a Session. `Option+Up` / `Option+Down`
on a focused Session row moves it within its Project and announces the move. The same keys on a focused Project name provide the
keyboard-equivalent reorder and announces the resulting position. The PrimarySidebar header
carries the Session history pair — Back then Forward, ghost icon buttons in `--muted` that lift to
`--foreground` on hover, placed immediately after the traffic-light clearance because that is
where every browser puts them. They are `no-drag` islands in the header's drag region. A direction
with an empty stack renders disabled rather than hidden, so the pair never reflows and its
position stays learnable; the shortcut and command name reach the user through the shared command
tooltip instead of a bespoke label. Archived Sessions use one stable PrimarySidebar footer entry
with a global count. Search, filters, Project-grouped results, restore, and delete live in a
full-width management dialog. Project disclosures contain active Sessions only, so low-frequency
history never fragments navigation. A disclosure renders its first five Sessions in sidebar order
plus a `Show N more` row that reveals ten more per activation and disappears once the list is
complete, so a busy Project never buries the Projects below it. The selected Session always
renders even when it sits below that window. The revealed count is per-Renderer-lifetime: a relaunch starts from the short list
the same way it starts scrolled to the top.

A Session working in a Git worktree rather than its Project root is marked by the VS Code `worktree`
codicon in a leading fixed-width 14px column, reserved for the whole Project group at once so every
marker in a group lands on one vertical line and titles never shift sideways as Sessions come and
go. A Project with no such Session reserves nothing. It is a second fixed track rather than a share
of the trailing one, which is sized for exactly one glyph and already arbitrates between lifecycle
status and the pull request. The glyph is deliberately neither `FolderGit2`, which already means
"Workbench Root" in the root picker and "repository" in Source Control, nor `FolderSymlink`: at 12px
beside the trailing pull request glyph either one read as a third folder or Git mark on the same
row. The full worktree name stays in the Session hover card.

Adopting a worktree as a Workbench Root auto-registers a Project for it, and that Project never
occupies a top-level slot in the PrimarySidebar. The list shows the Projects the user added; a
worktree is a property of the Session working in it, which the marker above already says on the
Session's own row. A second top-level row per worktree would double the list without naming
anything new, and no PrimarySidebar affordance — reorder, delete, disclosure — applies to a row the
user never created. The consequence is that such a Project is reachable only through its owner:
deleting the owner deletes it, and the confirmation names the ones about to go.

Pull request lifecycle owns the glyph color: open is `--success`, closed is `--danger`, merged
is `--merged`, and draft is `--muted`. Checks appear as text in the hover card, with failures in
`--danger`; never overlay a badge on the small PR glyph or recolor it for CI. The existing animated
yellow Session attention ring keeps its separate meaning and position.

The Status tab carries a compact, static badge anchored to the heartbeat icon's lower-right
corner, following VS Code's activity-bar badge placement. Use a 16px minimum circular surface that
grows into a capsule, `badge` text, and a surface-colored ring separating it from the icon. It
counts failed PR checks and current production/preview deployments across the selected Session's
repositories, deduplicated by identity. PR rollups, historical deployments, pending work, and
provider-fetch errors do not inflate the number. Zero or unavailable status hides the badge;
tooltip and accessible description expose the full count and categories. Switching tabs does not
clear failures; switching Sessions changes the badge scope.

Badges are an extension view capability, and an extension reports only meaning: a plain-text
description plus one of `count`, `error`, or `warning`. Appearance is the Workbench's, so two views
can never paint one container in two unrelated colors. A `count` badge uses
`--badge`/`--badge-foreground`; `error` and `warning` use `--error-badge` and `--warning-badge` with
their derived foregrounds, and each carries a fixed Workbench glyph inside the badge so severity
survives without color. Those two roles are separate from `--danger` and `--warning`, which are text
colors imported from the editor's error and warning squiggles and are not fills.

Within a container the Workbench keeps the most severe kind present and totals only that kind,
capped at `99+`; a severity with any uncounted badge shows its glyph alone rather than a partial
total. Git counts all working-tree changes across the current Workbench Root's repositories,
including hidden and truncated entries. Every contributing view's description reaches the
accessible name whatever the digit shows. Badge reads activate declared providers even before their
views open. Zero, no selected Session, and unavailable extension states hide the badge; counts
never carry across Workbench scopes.

**Tab strip** — active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, and a 2px `--accent` top border, VS Code style. Inactive: `--surface` +
`--muted`. The active tab always shows its close button; an inactive tab reveals a `--muted` one
only under the pointer or keyboard focus, VS Code style — hunting for a control that is always
there on the tab you are working in is the friction this removes, and keeping the inactive ones
muted is what stops a crowded rail from reading as a row of X's. A dirty tab shows its dot in that
slot instead and swaps to the close button on hover/focus, active or not.
Tabs fill the full 44px rail height. Document tabs fit their full labels; Terminal tabs divide the
remaining width with their full displayed content as the minimum. Crowded bars scroll rather than
truncating Terminal labels or imposing a fixed filename cap.
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
are ready. Every Git diff tab, single-file or multi-file, ends that slot with a `Diff View Options`
ellipsis popover holding `Inline View`, `Collapse Unchanged Regions`, and
`Show Leading/Trailing Whitespace Differences`. These are window-lifetime view preferences, not
persisted settings, and they are deliberately not mirrored into Settings: they are read-and-adjust
controls that belong beside the diff being read. `Collapse Unchanged Regions` starts at each
surface's own default — collapsed for a multi-file diff, expanded for a single file — and only
becomes one shared value once the user sets it. Ordinary file and single-file diff tab menus offer `Copy Path` and `Copy Relative Path`;
relative paths measure from the Workbench Project root, so one file yields one path wherever it is copied from — the
tab menu and the Files tree row agree, and a submodule or nested repository does not get a base of its own. The
containing repository is only a fallback for a resource with no Project-relative path at all, such as a diff opened
from a linked repository outside the Project.
Internal virtual tab identifiers are never copied as filesystem paths.
Session bootstrap and switching still mount without structural motion; actual close keeps the exit
animation. Transient Agent operations may temporarily use the existing text accessory after the
Terminal title and replace generic progress text while active. `Compacting` is the single
exception: it uses `--foreground` and a slow opacity pulse so long-running context compression
remains noticeable without animating the Agent icon or Session title. Work tabs carry no separate
process-state dot; process liveness remains available through diagnostics rather than duplicate
chrome. This does not govern the Session list's right-edge running spinner.

**Git decorations** — a file with working-tree changes reads the same wherever its name appears.
The name takes the `--git-*` color of its change, and a single status letter (`M`, `A`, `D`, `U`…)
sits at the trailing edge of the row or tab in the same color — the Files tree, the tab strip, and
the diff headers all render that letter from one component. Source Control still paints its own
from the Extension API's generic `tone`. The staged column
wins when both are set, so a file staged as added and then edited reads `A` everywhere. The file
type icon keeps its own color: it identifies the language, not the change. A directory in the Files
tree takes the color of the most severe change anywhere beneath it (conflicted, then deleted,
modified, renamed, added, untracked) but no letter, which would claim the folder itself changed.
Changes inside a submodule or a nested repository decorate that child repository's root and keep
climbing through its ancestors, stopping below the selected Workbench Root's own repository root —
its main checkout or a linked worktree, whichever the Workbench Root is. Only that one root is
excluded; a child root is a decoration the user can act on, not a boundary. A child root a parent repository reports as a moved gitlink is still a folder row, so it
takes the louder of that change and whatever is inside it, and still no letter. A directory's color
says there are changes under it, not that the enclosing repository tracks them. Inactive tabs keep
their decoration color — the point is to be readable across the whole rail without selecting each
tab. Ignored entries stay muted and italic and take no decoration. The decoration is visual only: a
row or tab is still named by its bare filename, and the status reaches assistive technology as an
accessible description (`Git: modified.`) rather than being folded into that name.

**Child repositories** — a directory that is a repository of its own takes the Git repository
folder icon instead of the one its name would earn, so a submodule is never mistaken for an
ordinary folder. This covers both a `.gitmodules`-declared submodule and a directory someone cloned
in independently; the row's tooltip and its accessible description name which of the two it is,
since only the submodule shows up as a change in the parent when its recorded commit moves. A
linked worktree takes no mark: it is a peer checkout, not something nested in this tree. The mark
is independent of the change decoration above — a submodule or nested-repository root can carry the
icon and a change color at the same time, and still no letter.

**Editor breadcrumbs** — an ordinary Project file gets one 24px metadata row below the tab strip.
Its Project-relative path sits on the left and the current file's last-change annotation sits on
the right; both use dense, muted chrome on `--surface`, separated from the editor by one hairline.
Only the file segment carries its file-type icon. Clicking any segment opens a flat sibling picker:
folders navigate one level at a time, files open in the Session's preview Editor, and no symbol
outline or settings are added. A symbolic link reached through the Project root is an ordinary
entry, not a dead one: a link to a folder navigates into it and a link to a file opens it, with no
extra confirmation. Cached link metadata can be stale or missing after a probe timeout, so
activation asks the Server for the target's current kind instead of trusting what the row displayed. The path uses one keyboard tab
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
`default` badge, and a deployment keeps its `alias`, `inspect: details`, and optional
`created`; the row itself opens those details for every deployment state. Canceled deployments use
explicit `canceled` text and a muted circle-slash, while a branch deployment's decorative trailing
icon identifies production or preview without adding another focus target. A check carries its
duration and `logs`, and a provider failure puts its recovery hint in the prose line rather than
forcing it into a list row. The row's own destination appears once, as the trailing `link` row, and
never a second time under a more specific label. A row with nothing structured to add renders
heading-only rather than falling back to the plain surface. The rich
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

**Project-wide provider failures** — a failure that belongs to the account rather than to one
repository is stated once at the Status root and dropped from the repository subtrees: a lost
connection, and an API budget every repository draws on. A Project holding a repository and its
submodule otherwise printed the same account-level sentence twice, each with its own button. A rate
limit is a wait rather than a fault, so it takes the hourglass instead of the danger tone, names the
clock time Caxri resumes, and shows no action while that pause is still running — the retry it would
offer is exactly the request the limiter is refusing. It keeps one row per provider, because each
budget resets on its own schedule. The status bar's pull-request chip follows the same rule: it names
the reason it has no pull request to show (`PR rate limited`, `PR needs login`, `PR offline`) rather
than the single `PR unknown` that was true of all eight reasons and useful for none, and its hover
card carries the full recovery sentence.

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

**Uncommitted work in a non-working mode** — Last Commit and Pull Request replace a repository's
file list with that commit's or that pull request's files, so a repository holding uncommitted work
renders identically to a clean one. A mode that answers one question must not silently answer a
different one, so the repository row states the count it is not showing (`· 3 uncommitted`) and
carries a diff-mark button back to Working Tree Changes. Both disappear at zero rather than sitting
there reading `0 uncommitted`. A repository with no pull request keeps the heading
`Pull Request Changes` in Pull Request mode: leaving it at `Changes` made its zero read as a clean
working tree instead of an absent pull request. On a repository row the counts outrank the
repository name: the name ellipsizes when the row runs out of width, because the row's tooltip and
the Project already carry it while the counts are stated nowhere else. A name that refused to
shrink collapsed the meta span to zero width and printed the counts on top of the name.

**Git diff exclusions** — `git.diffExclude` hides matching repository-relative paths from Git
change lists and from `Open Changes`; it ships filtering test files out by default, because a
review of "what changed" almost never opens with them. A default that hides work is only honest if
the surface says so and offers a way back, so hiding is never silent. The Source Control header's
eye button, which reveals the excluded files in place, appears only when exclusions are actually
hiding something — a control that toggles nothing but is always on screen teaches the user it is
decoration. In a multi-file diff tab the hidden count is stated in a `role="status"` notice
carrying two ghost buttons: `Show them` reopens the same aggregate diff with exclusions revealed
and retires the occurrence it replaces, so the user is never left with two identically labelled
`Changes:` tabs, and `Edit exclusions…` opens Settings scrolled to the `Excluded Git diff files`
row rather than to the top of the list. Both buttons name themselves to a screen reader through the
notice they sit beside. Showing excluded files lives in the tab's resource path, not in component
state, so the revealed view is an ordinary diff tab that survives restore.

**Terminal panes** — the focused pane keeps the accent inset ring (with the active tab's top
border it forms the screen's one accent focus). The xterm viewport and scrollbar are full-bleed at
the right edge; top/left text padding belongs to xterm's content box so it never creates an outer
scrollbar gutter. Exited Terminals keep their final output and reserve a compact recovery row
beneath the xterm viewport, never over it. A zero exit without a signal is `--muted` / neutral
(`Process exited normally`); startup failures, signals, and non-zero exits use `--danger` text
and the matching human failure label. Surface actions, the command palette, and
`Command+Shift+R` restart the same durable Terminal record.

**Dialogs** — backdrop `--overlay` + `backdrop-filter: blur(2px)`; content radius 8, border
`--border`, shadow from `--shadow`. Never a close X inside the command palette. Pickers are the one
exception and use a second, named scrim: fully transparent, no blur, still capturing pointer events
so an outside click dismisses the picker instead of reaching the control underneath. A picker is
something the user reads the workbench through while choosing a destination in it, so dimming the
thing they are aiming at defeats the surface.

**Command palette** — rows show command title left, `kbd` shortcut hint right (render from live
keybindings, `badge` size, `--elevated` chips). Group headings stay. Width 560px.

**Session switcher** — the hold-to-cycle MRU overlay (`Recently used Sessions`) is a modal moment
that ends on key release, so it wears the picker scrim above rather than the Dialog one, and the
palette's 560px width, centred. Like VS Code's editor switcher, the workbench stays fully readable
underneath while the chord is held; the scrim still swallows pointer events, and clicking it cancels
exactly as Escape does — without that, clicking a Session in the PrimarySidebar mid-chord switches
once and then the switcher commits a second, stale jump on release. It reads top to bottom as caption / list / hint: a panel-caption
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

A consequential choice may not live only inside a free-text field. Every bundled Agent launches
without per-action approval by default, and until that was only a CLI token inside
`Initial arguments`, the setting was unreadable to anyone who did not already know the flag —
principle 3 applied to the one row where it matters most. Each provider now carries a named Switch
directly above `Initial arguments`, stating in plain words what the two answers mean and that the
change reaches Terminals started from now on. The Switch is derived over the same argument list the
user can hand-edit rather than a second stored preference, so a raw edit and the Switch can never
disagree, and it moves only the approval tokens — a confinement argument such as Grok Build's
`--sandbox workspace` decides where the Agent may work, not whether it asks first, and survives
untouched in both directions. Where a plain-language control and a raw field describe the same
state, the raw field stays authoritative and the control reads from it.

**Toasts** — three variants (`info`/`success`/`error`) with a 3px left bar in the status color and
matching icon; `info` uses `--muted` for its bar (an accent bar would be a second accent). Sonner
owns the queue, timers, keyboard access, and swipe dismissal. All three variants auto-dismiss after
4s of visible, non-interacting time; only explicit `persist` notices stay until dismissed. Stack
bottom-right above the status bar, with three visible cards. Hover or keyboard focus pauses expiry.
Use the close or action button to dismiss; clicking the message body does not dismiss it. Sonner's
internal transition/removal timing is a third-party exception to the motion token layers above;
its built-in reduced-motion media rule disables animation. Theme overrides live in `styles/styles.css`.

**Notifications** — the status bar bell opens a 384px-wide, viewport-constrained popover with
recent messages, Project context, occurrence counts, removal, clear-all, and a Settings shortcut.
History holds at most 100 entries in this window's memory and never stores action callbacks;
reloading the window clears it. Opening the center marks its entries read. Ordinary success
feedback such as copying a path stays ephemeral. Native Agent and delivery alerts enter the
same history without a second popup. Reminder popups offer an options button to stop showing
that event type across all Projects; muted events remain in history without an unread count.
Settings → Notifications restores those preferences and groups the existing native notification
controls. Failures and persistent data-loss notices cannot be muted. Worktree fallback is an
ordinary four-second reminder now that its record remains available in the center.

A workbench change the user did not perform announces itself. An Agent that moves a Session into a
linked worktree re-roots Files, Source Control, Project Status, and the Editor, so it raises the
same ordinary four-second reminder as fallback — naming the destination and carrying an inline
`Undo` back to the previous root, because the only other cue is a folder name changing in the
status bar. A switch the user performed themselves stays silent; the wire reason (`followed`)
carries that distinction, since the picker and an Agent otherwise reach the same commit path.

Some notices are held until dismissed rather than expiring. A GPU process crash and the moment
repeated failures turn GPU acceleration off for the window both carry `Restart in GPU Safe Mode`,
which is reachable from nowhere else — history stores no action callbacks — so a four-second expiry
would remove the recovery route while the condition it reports still holds.

A boot-flag write that only the next launch picks up is held for the same reason: the user is still
inside the modal Settings dialog, and the notice carries the only statement of what the restart is
owed for. That one is a status rather than an event, so it names every flag still differing from the
running instance's launch values, and it is retracted once none remain.

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
