# Caxri UI design spec

Authoritative visual and interaction spec for the workbench. Implementation work packages
reference this file; deviations require updating this spec first.

## Principles

1. **The Agent's work is the hero.** Chrome (primarySidebar, tabs, secondarySidebar, status bar)
   stays low-contrast and quiet. Saturated color is reserved for content (a Chat transcript, a
   Terminal, a document) and live status.
2. **One durable accent focus per screen.** `--accent` marks exactly one resting focus at a time:
   the focused pane together with its active workbench tab's 2px top border. The tab border and the
   pane ring express the same focus and count as one, VS Code style. The tab border drops out at a
   one-tab workbench, where it would mark a choice the user never has (see **Tab strip**), leaving
   the pane ring to carry focus alone. Primary buttons and transient, action-scoped feedback (the
   drag insertion line, drop-target tint) may also use `--accent` because they exist only for the
   duration of an interaction. Persistent chrome state expresses itself through foreground shades
   and background elevation, never through additional accent borders.
3. **No implementation vocabulary in the UI.** Users see "Settings", "Session", "Restart", never
   "Runtime", "hot reload", "last-known-good", "bytes".
4. **Every color comes from a token.** Zero hardcoded hex in component CSS. Themes are
   user-importable, so any literal color is a future light-theme bug. The one exception is a color an
   external system owns for its own content: a Linear workflow state, whose palette each workspace
   configures. Caxri's semantic roles cannot express someone else's palette, and quantizing it back
   to `success`/`warning` renders a state Linear shows green as yellow. Such a color arrives as data
   through a schema-validated `#RRGGBB` field, never as a literal in source, tints exactly one glyph's
   foreground, and is absent for every Caxri-owned icon, which inherits its row's theme color.
5. **Tailwind v4 utilities over the semantic runtime tokens, and only those tokens.** The color
   roles below are bridged to Tailwind via `@theme inline`, so utilities like `bg-surface` resolve
   to the runtime theme variables and imported themes restyle the whole app live, the standard
   shadcn pattern. The default Tailwind palette is unregistered (`--color-*: initial`), so
   `bg-blue-500` resolves to nothing. Unregistering does not reject it: Tailwind emits no rule and
   says nothing, and the class name ships on the element styling nothing, which is how the pairing
   QR code lost its white quiet zone. `caxri/registered-color-utilities` is what turns rule 4 into a
   check: a color utility whose token is absent from the `@theme inline` bridge is a lint error,
   including one that names a raw theme color such as `--selection`, which is referenced as
   `bg-[var(--selection)]` instead. Non-color scales (spacing, type, radius) use stock Tailwind
   defaults.
6. **Say each meaning once.** An icon, a reserved slot, or a control that already names a state
   does not also get an adjacent visual label repeating that state. Accessible names and tooltips
   stay complete; they are not the duplication this rule forbids. The Panel caption that omits the
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
   (a Git error is not "not a repository"). A surface or region waiting for its first data draws
   `LoadingSkeleton` (`components/loading-skeleton.tsx`) shaped like what will arrive (`list`
   rows, `document` lines, `page` cards, `transcript` Chat turns) and names the wait in its
   `label`. Its shapes appear only after `LOADING_SKELETON_DELAY_MS` (500ms), so a local load
   (opening a file, a lazy chunk) finishes before any gray shape is drawn; they then fade in on
   `--motion-overlay-enter` and pulse on `--motion-skeleton-pulse` (static under reduced motion).
   `isImmediate` skips the delay for a region inside a surface whose own chrome is already drawn,
   where a blank region reads as real empty content: a Chat transcript between its header and
   composer looks like an empty conversation, so its turns placeholder fades in at once. Wrap a
   surface whose placeholders hand over to each other (an editor pane: file read, then editor
   module; a tree view: root, then its branches) in `LoadingSkeletonScope`, so the chain reads as
   one wait instead of skeleton, blank, skeleton. Content already on screen never regresses to a
   skeleton: a refresh keeps the shown rows until the new ones are ready. It replaces a centered
   `Loading…` line that collapses the layout and then jumps. A `Spinner` stays for inline progress
   inside an already-rendered control or row (a button, chip, picker, `Loading more` row) and for
   a wait whose copy explains something the user should know, such as a process starting.

10. **Show only what a person still needs to see.** A surface earns its place by telling the user
    something they still need while Agents do the work: which Session needs them, what an Agent
    changed, whether it worked, or how much plan usage is left. Do not add a panel, column, or status
    item that only mirrors internal state, or that reproduces a traditional IDE surface without that
    reason. See [ADR 0020](docs/adr/0020-agent-development-environment.md).
11. **Leave the work to Agents.** A person's controls review, steer, and decide; they do not redo
    Agent work. Do not add a manual control for Git work that belongs to Agents, such as staging or
    committing. The pull request merge button is the deliberate exception, because merging is the
    decision a person still makes.

`apps/desktop/src/renderer/src/styles/theme.css` is the single Tailwind/default-theme/bootstrap
source imported by both `styles.css` (main workbench) and `process-explorer.css`. Entry
files contain only their window-specific rules. `components.json` points shadcn at that shared
source. Its `baseColor: zinc` is immutable initialization metadata for the chosen shadcn style, not
a live palette: the shared `@theme` unregisters every default color and exposes only the semantic
roles below.

## Tokens

### Color roles (semantic layer over theme colors)

| Token                                                     | Role                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--background`                                            | editor/terminal canvas                                                          |
| `--surface`                                               | chrome: primarySidebar, tab strip, secondarySidebar, status bar                 |
| `--elevated`                                              | hover states, cards, popovers                                                   |
| `--border`                                                | 1px hairlines between regions                                                   |
| `--foreground`                                            | primary text                                                                    |
| `--muted`                                                 | secondary text, inactive icons                                                  |
| `--accent`                                                | the single focus indicator + primary buttons                                    |
| `--accent-foreground`                                     | text/icons on accent fills (derived, not hardcoded)                             |
| `--switch-thumb` / `--switch-thumb-off`                   | Switch thumb over the accent / border track: derived at 3:1 non-text contrast   |
| `--success` / `--warning` / `--danger`                    | status dots, exit banners, destructive buttons                                  |
| `--merged`                                                | landed work: the merged pull request glyph                                      |
| `--chart`                                                 | quantity data series: Usage heatmap, trend line, share bars, hourly bars        |
| `--badge`                                                 | neutral view-container count badge fill                                         |
| `--badge-foreground`                                      | text on `--badge` (derived, not hardcoded)                                      |
| `--error-badge` / `--warning-badge`                       | severity view-container badge fills: the glyph chip, never a text color         |
| `--error-badge-foreground` / `--warning-badge-foreground` | glyph on the severity fills (derived, not hardcoded)                            |
| `--git-added` … `--git-conflicting`                       | working-tree decorations: added, modified, deleted, untracked, conflicting      |
| `--tab-*`                                                 | tab strip fill and label, per state: active, inactive, hover                    |
| `--list-*`                                                | tree, list, and picker rows, per state: hover, focus, active/inactive selection |
| `--title-bar-*`                                           | window title bar fill and label, by whether the window is focused               |
| `--overlay`                                               | dialog backdrop: `color-mix(in srgb, var(--background) 60%, transparent)`       |
| `--shadow`                                                | elevation shadows: a theme value, read from `widget.shadow` on import           |
| `--indicator`                                             | neutral (non-accent) selected-tab underline for secondarySidebar/settings tabs  |
| `--state-*`                                               | hover, selected, and focus washes for surfaces that borrow no `--list-*` state  |

Derive `--accent-foreground`, `--switch-thumb`, `--danger-foreground`, `--badge-foreground`, and `--overlay` in one
place from theme colors. The status bar uses `--surface` plus a top hairline, never an accent fill.

Tabs, list rows, and the title bar own their states rather than borrowing a surface: eighteen
`--tab-*`, `--list-*`, and `--title-bar-*` tokens, plus `--shadow`, which became a theme value
instead of a derived one. Each reads one VS Code key on import (`tab.activeBackground`,
`list.hoverBackground`, `titleBar.activeBackground`, `widget.shadow`, and so on) and falls back to
the role that surface borrowed before, so a theme naming none of them looks exactly as it did. The
inactive list and title-bar states inherit from their active counterparts, which is VS Code's own
rule: a theme that styles only the focused state means the unfocused one to match. Alpha survives
the import, because `list.hoverBackground` is a translucent wash in most themes and flattening it
would paint an opaque band over the row instead of tinting it. An explicitly given color is never
rewritten just because it equals another role, and none of these states writes back into
`--background`, `--surface`, or `--elevated`; those three stay the canvas, the chrome, and the
popup fill. Read the decision on
[issue caxri#852](https://github.com/tjx666/caxri/issues/852#issuecomment-5656606135) for why each
key was chosen.

The `--state-*` tokens are the single owner of the translucent hover, selected, and focus washes
that rows and controls outside the `--list-*` families used to hand-mix with `color-mix`. They are
derived in `styles/theme.css` from `--elevated`, `--foreground`, `--accent`, and `--selection`
rather than stored per theme, so built-in and imported themes get matching washes through the roles
they already set. Each name is one intensity class, not one global value: `--state-hover` (60% of
`--elevated`: sidebar and Session rows, menu items), `--state-hover-quiet` (45%: large Settings
blocks), `--state-hover-ink` (10% of `--foreground`: compact chrome buttons), `--state-hover-ink-quiet`
(6%: dense process rows), `--state-track` (6% of `--foreground`: a segmented control's resting track), `--state-selected-quiet`, `--state-marker`, `--state-drop-target`,
`--state-focus-ring` (the 3px halo on form controls), and `--state-handle-*` (resize seams). Use the
closest class from Tailwind (`hover:bg-state-hover`); add a new class here instead of writing a
`color-mix` recipe in a component. A surface that needs a different strength gets a new named token,
not an inline percentage. `renderer-theme-contract.test.ts` fails when these recipes reappear
outside `theme.css`.

The pickers are list rows too: the command palette, the two status-bar pickers, the terminal link
picker, the Agent actions dialog, and the `Cmd+P` path browser read `--list-*` exactly as the Files
tree does, so one imported theme reaches all of them at once. They need fewer of the four states
than a tree, because a picker's pointer selects whatever it passes over: the row under the cursor
and the row the arrow keys are on are the same row, right up until the pointer stops and the keys
carry on without it. The pickers built on `cmdk` answer that by painting only `--list-focus-*`; the
path browser, which owns its own rows, by offering `--list-hover-*` to the rows that are not the
keyboard row. Either way exactly one row looks current, never two.

The two inactive title-bar roles need to know whether this window is the focused one, and CSS cannot
ask: `:window-inactive` is a WebKit pseudo-class and Chromium, which is what Electron runs, has no
equivalent. `lib/window-active.ts` publishes the condition as `data-window-active` on the same
`<html>` element the color variables land on, and `styles/theme.css` defines a `window-inactive:`
variant over it, so every surface that paints a title bar switches together.

A built-in preset fills these roles from its upstream theme only where that clears the contrast
floor. Every label the focused window shows (the three tab states, the four list states, and
`titleBarActiveForeground`) must reach WCAG AA on its own fill, asserted per theme and per role in
`domains/__tests__/theme-control-colors.test.ts`. This is the same rule `--muted` already answers
to, and for the same reason: several upstream themes set `tab.inactiveForeground` to their comment
color, which is exactly the substitution that rule forbids. A preset is Caxri's own product, so it
takes the correction; an imported theme is its author's and keeps the original values.
`titleBarInactiveForeground` is the one exemption. It paints only while the whole window is
unfocused: inactive UI under WCAG 1.4.3, and the one case where the dimming is the message, which
is how macOS and VS Code both fade an unfocused title.

A preset must also leave the active tab distinguishable from its neighbours by fill or by label,
because the accent line above an active tab is drawn only on the focused pane and the other pane in
a split has nothing else to go on. A theme that paints both tab states one color has to give the
difference back somewhere, since the contrast floor above is what pulls the two labels together.

`--badge` and the five `--git-*` roles exist so the theme, not the component, decides these colors.
Both mirror a VS Code key a theme author already writes (`activityBarBadge.background` and the Git
extension's `gitDecoration.*ResourceForeground`), so a built-in preset carries the exact value VS
Code would paint, and a VS Code theme import reads them straight across. Before them the count badge
was hardcoded `--foreground` on `--background` (white in every dark theme, where VS Code shows the
theme's own badge color) and the status letters borrowed `--success`/`--warning`/`--danger`, which
collapses added and untracked onto one color and paints a modified file the same amber as a warning
chip. `renamed` deliberately has no role of its own: VS Code's two defaults resolve to the same
green, so it shares `--git-untracked`; ignored entries stay on `--muted`. A theme file saved before
these roles existed is repaired by `upgradeThemeColors` the same way `--merged` is.

`--chart` paints quantities, not states. Usage charts used to borrow `--success`, so retuning status
green repainted every chart and a busy day read as "passed". Charts draw intensity as opacity steps of
the one role (`bg-chart/25` through `bg-chart`) rather than a multi-hue scale. Every built-in theme
seeds it with its own `success` value, so the default appearance is unchanged; a VS Code import reads
`charts.green`, falling back to the imported `success`, and `upgradeThemeColors` backfills an older
custom theme from its `success`.

A chart that compares categories rather than quantities (the Benchmark chart's one series per Agent)
derives its hues from `--chart` with relative OKLCH, a third of the wheel apart, instead of adding a
brand palette, so every theme retints it. It clamps lightness and chroma into a readable band, and
pairs each hue with a marker shape so color is never the only cue.

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
`domains/__tests__/theme.test.ts`, which also pins `styles/theme.css` to the same values so the
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
| `badge` | 10px | tiny badges/kbd hints only, never sentences                |

Sizes outside the tier table are banned. 8px, 9px, and 10.5px are called out explicitly because
they each shipped once as regressions. Monospace previews and diffs use `meta` size. Dense prose
may use unitless `1.45` or `1.5` line height; compact uppercase headings may use `0.04em` or
`0.06em` tracking. No other arbitrary typography values are allowed.

Numbers that change while visible (timers, elapsed durations, percentages and meters, token and cost
counters, unread and match counts, badges, zoom percentage, line and column) use tabular digits
(`tabular-nums`; `fontVariant: ['tabular-nums']` on Mobile), so the layout does not shift as digits
change. Static numbers (versions, fixed dates) keep proportional digits. Put the class on the
shared component when every usage shows changing digits (`StatusItem`, `StatTile`).

### Spacing and radius

- 4px grid: primary gaps and paddings are 4, 8, 12, 16, 24. Optical half-steps (2, 6, 10px) are
  allowed inside compact control chrome when a glyph or label does not center on the primary grid.
  Two grandfathered measurements predate the grid and are kept only to avoid chrome churn: the
  Status Bar's 5px item inset/gap and the shared panel caption's 3px top/bottom inset (preserving
  its 34px rail). Do not imitate them in new work. The panel divider's revealed hairline is 3px on
  whichever axis the seam runs (`w-[3px]` between columns, `h-[3px]` between rows), so the two
  orientations are the same seam, not two thicknesses. The macOS traffic-light clearance is the
  only platform spacing exception: 84px expanded-header and 78px collapsed-header/tab-strip left
  padding while windowed. Both are horizontal clearance for the window controls; fullscreen hides
  those controls and omits the clearance. The 36px figure under Window chrome is rail height, a
  different axis. The Agent Chat transcript's left padding beside the message rail is the one
  computed inset: it stays at the column's 16px while the centered column's own margin already
  clears the rail, and grows toward 28px only as a narrowing Chat loses that margin, so showing
  the rail never shifts a wide transcript away from the composer's edge.
- Control heights: 24px compact inline rename/history, 28px dense workbench search, 36px standard
  Settings fields/buttons, and 44px palette/path input.
- Radius: 8px controls (buttons, selects, toggles, text fields), matching the Codex app's roughly
  quarter-height rounding; a 24px compact field takes 6px so it does not read as a pill. 6px
  cards/list selection, 8px dialogs and palette. `rounded-full` is
  reserved for intrinsically circular shapes: activity dots, the drag insertion line's leading
  cap, and the Switch track/thumb. The Agent Chat composer is the one other sanctioned exception,
  copying the Codex app's composer: its `+`, its Plan chip, its model picker pill, its 28px primary
  action circle, and the effort slider's track and thumb. The Agent-choice dialog's tiles are the
  last: their 56px icon wells and the tray holding them take 12px (`rounded-xl`), the macOS Dock's
  app-icon proportion, because an 8px corner on a 56px square reads as a button rather than an app
  icon. No other radii.
- Keyboard focus on a shared control (`Button`, `Input`, `Select`) is one treatment: an `--accent`
  border plus a 3px `--accent` glow at 50%, shown only for `:focus-visible`, so a pointer click
  draws nothing. A feature-local icon button uses the shared `Button` (`size="icon"`, `ghost`) to
  inherit it instead of hand-rolling a borderless `<button>` with no focus state.

`apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts` enforces the numeric
arbitrary-class allowlist above and rejects feature-local raw text inputs and raw checkboxes.
Boolean controls use the shared shadcn primitives: instant preferences render Switch, deliberate
pre-submit opt-ins render Checkbox, and label/description/control rows compose Field.
`input[type=color]` is the one remaining native input (the OS color picker has no shadcn
equivalent). Numeric arbitrary width/height constraints are also closed by default; the test's
small allowlist covers existing structural viewport, empty-state, and platform-diagnostic geometry,
not additional control-density tiers. Every allowlist entry is a grandfathered measurement, not a
precedent; a new arbitrary value requires updating this spec first with a stated reason.

The Status Bar's two glyph boxes are the one entry admitted under that rule rather than inherited:
`size-[13px]` on an interactive item and `size-[12px]` on a read-only reading size the icon to the
text tier it sits beside (`base` and `dense`), which is why they repeat the sanctioned type sizes
instead of introducing a third measurement. They are declared once on the two shared status-bar
recipes so a caller can hand over any rendered glyph (a Lucide component, a Linear workflow icon)
without knowing which of the two bar heights it lands in. Sizing a glyph at its call site is the
drift this replaces; do not reintroduce it.

## Component redlines

**Window chrome**: `titleBarStyle: 'hiddenInset'`. The 36px PrimarySidebar, workbench, and
SecondarySidebar top rails share one bottom edge, and the workbench rail is the focused pane's tab
bar, which doubles as the title bar (see **One tab level**). Workbench tabs fill the full 36px rail, VS Code
style, so the active tab's `--background` fill reaches the rail's top edge. The macOS traffic lights
are centered in 36px (`y: 11`). SecondarySidebar rail tabs fill their 36px rail. SecondarySidebar tabs divide the whole
rail evenly; a compact capped indicator marks the selected slot. The logo-free PrimarySidebar header is
the drag region (`-webkit-app-region: drag`, interactive children `no-drag`). The Session history
back/forward pair is the only control that rail carries, and it opts out of the drag region so the
buttons navigate instead of moving the window. Add Project has no chrome of its own there: its entry
points are `Cmd+O` (which works from a focused Terminal or editor too), the native Project menu, the
command palette, and the Welcome view's primary action while no Project exists. A workbench-wide
action that a shortcut, a menu, and the palette all reach does not also earn a hover-revealed button
in a 36px rail. The collapsed PrimarySidebar preserves the same 36px-tall drag region beneath the
traffic lights.

**Files caption actions**: `New File`, `New Folder`, `Collapse Folders`, in that order. Search left
this row when the centered overlay took the job: a caption 34px tall has to share its width with a
Project name, and a shortcut, a menu and the palette all reach the overlay already, so a glyph there
bought nothing.

**Welcome**: heading "Project-first development." Body copy uses "folder" to match VS Code's
Open Folder / Add Folder to Workspace, not "directory" or "local folder". The primary action is
Add Project.

**Path browser**: `Cmd+P` opens one 44px palette input with the current Project rendered as a
removable leading anchor. With an empty field and the caret at its start, Backspace or Delete removes
that anchor and turns the same control into a normal path field. Free-path mode accepts `~/`, `../`,
relative paths from the last browsed folder, and `/`-rooted absolute paths. Matching folders and files
remain visible below the field while the user types; Tab completes one unambiguous result, arrows move
through results, and Enter opens the selected result. This flow never opens a native folder picker.
Project-anchored mode retains Project-local create actions. Free-path mode is browse-and-open only: a
file inside the current Project still uses its normal editable Editor path, while an external file becomes
an editable virtual Editor tab in the current Session whose saves write back to that file through Main. The
tab survives only for the Renderer lifetime and never creates a Project or Session or enters durable Session
state.

**Status bar**: `--surface` background, top hairline, `meta` text in `--muted`. The left side
shows Project and Git context, plus the delivery chips the current branch resolves to: its pull
request, its Linear issue, and its acceptance report. Each one is a chip only when the branch
actually has that thing; none of them holds a slot to say "none". A delivery chip leads with
whatever a person would say out loud about it, so the Linear chip leads with `ABC-123` while an
acceptance (which has only an opaque id) spends its width on the passed-check tally in the colour
of the current verdict, and keeps the subject, round, and provenance on the hover card. A link Caxri
recognized but could not read is `unknown`: `--muted` and not clickable, because it has no
destination and must not look like it does. When the bar's content does not fit, whole chips drop
one at a time, lowest first: child-process count, memory, Agent output speed, Agent conversation
usage, Linear issue, acceptance, pull request. A chip in its warning state (the usage chip once a
limit is nearly spent or, at the current rate, on track to run out before it resets, which its tooltip explains) drops only after
every calm chip, because hiding a warning defeats it. A chip's label is never truncated. The decision is by
measured width, not fixed window breakpoints, because which chips are present (an Agent's two chips,
a Caxri Bot chip, a debugging disclosure) changes how much room the rest needs; a hidden chip is
still measured off screen, so it returns once its current width fits again, and one whose data goes
away stops crowding out chips that fit. Everything else (the bell, degraded and update
chips, Terminal progress, the debugging disclosure, Caxri Bot chips including `N need you`,
pending peer approvals, and the Project root and branch pickers) is never
dropped; the pickers cap their own width instead.
Acceptance outranks Linear because it reports whether the current work passed, which changes what
the reviewer does next; the pull request survives longest because it is the branch's identity.
The right side follows the active tab: a normal file shows
current-line blame, selection, cursor position, and language; an external file (opened from outside
the Project, such as from a Terminal link) shows the same minus blame, since there is no Project
history to blame it against; a Terminal shows Terminal progress, process-tree memory, and child
count. Terminal progress takes an hourglass (`Hourglass`), because `Gauge` belongs to the Agent
output-speed chip that sits beside it. The memory chip turns `--danger` while that Terminal's tree is
above the shared resource-alert thresholds (see `docs/process-explorer.md`), and its tooltip names
the CPU reading and the threshold, so a runaway Agent is visible before its alert toast fires.
An Agent Terminal also shows its Agent's output speed (`62 tok/s`) once the Agent's transcript has a
measured response. It is a persistent gauge, not a transient Agent operation, so it lives here. It
carries no threshold colour: the number is measured, and what counts as slow is the reader's call.
The one colour it can carry is the provider's: while the Agent's provider reports maintenance or
degraded performance a `--warning` dot marks the gauge glyph's top-right corner, and a partial or
major outage marks it `--danger`. The dot is drawn into the glyph, so the chip keeps its width as it
comes and goes, and the chip's accessible name ends with the same status in words
(`API status: Partial outage`). An operational provider, an unread or unreadable status page, and a
provider without one show no dot.
The hover card breaks it down by last response, turn, and conversation (the turn row folds into the
conversation row while both cover the same responses), lists provider incidents as at most one line
plus `+N more`, charts the recent responses, and states the method (see `docs/agent-throughput.md`).
Beside it, the conversation's running usage (`1.2M · $3.40 · 5h 62% left`: tokens, estimated cost, and
the share left of each shown rate-limit window, every window saying `left` so none reads as used) appears once the transcript records a billed
request. Cost is left out while no model has a price, since `$0.00` would read as free. The hover
card breaks tokens down by kind and lists every limit window with its reset; clicking opens Usage
(see `docs/usage.md`). Blame lives here and nowhere else. The editor header once
carried the file's last commit too, and on any line belonging to that commit the two read
word-for-word the same; the status bar's is the finer answer, it follows the cursor, and it does not
take width from the breadcrumbs. Transient Agent operations stay with the owning work tab
instead of being duplicated here. Diff tabs show neither file nor Terminal details.
Caxri status appears ONLY when degraded (`Reconnecting…` / `Caxri stopped`) as a
`--warning`/`--danger` chip; healthy state shows nothing. The chip is informational; recovery
lives in the native Relaunch dialog, so the chip never fakes an action it cannot perform. The same
rule decides when a degraded chip becomes clickable: the Terminal's `Software` renderer chip is a
button when GPU acceleration is disabled or a failure has settled. Confirmation either enables
acceleration in Settings or retries the current Terminal's GPU renderer without changing settings or
restarting the Terminal. A chip must never name a cause the Renderer cannot observe: a failed GPU
probe says the GPU is unavailable right now and keeps offering the retry that recovers it, because
the same probe passes again once a restarting GPU process is back. An explicit retry resets the
window's GPU incident budget; subsequent failures still use the normal limits. Automatic recovery in
progress stays informational to avoid duplicate retries. User-facing copy names the setting `hardware acceleration` and the
state `software rendering`; implementation vocabulary (`DOM renderer`, `WebGL2`, `GPU Safe Mode`,
`argv.json`) never reaches a label, tooltip, toast, or confirmation.
A downloaded or downloading update is the one non-degraded chip on that rail, and it is `--muted`
like Screencast Mode for exactly that reason: a release being available is not a degradation, and
colouring it would spend the vocabulary reserved for a Caxri that is not working. It earns a
permanent slot because the two states it carries (a download in flight, an install waiting) outlive
any dialog the user closed, and automatic discovery raises a notification that expires rather than a
modal that holds the screen. Clicking it opens the same dialog `Check for Updates` does.
The `Always Allow` chip is the same kind of standing mode: it appears only while the selected
Session holds a mobile-granted "Always allow in this Session" permission grant, stays `--muted`, and
revokes the grant on click, so a Session that silently allows every Agent permission request is
never invisible on the Desktop.
A peer message the user set aside with Decide later keeps its sender waiting, so the right rail
counts those requests (`2 messages awaiting approval`) until the last one is approved, denied, or
expires, and hides at zero. It keeps the clickable item's default foreground and never takes
`--warning`: a decision waiting on the user is not a degradation. Click or Enter reopens the
approval dialog on the request that has waited longest; the dialog, its waiting list, and the chip
read one queue, so they cannot disagree about what is still pending.
An open debugging channel earns the same kind of permanent muted slot, for the opposite reason: Caxri
ships accepting Chrome DevTools Protocol connections on loopback, and a capability that lets any local
program read every window and act as the user must be disclosed where the user can see it without
going looking. It is a mode the build or the user chose, not a degradation, so it stays `--muted`; it
reports what the process is actually doing rather than what `argv.jsonc` now says, because turning the
switch off leaves the channel open until the next launch (principle 9). Clicking it opens its setting.

A standing mode in its normal state is icon-only: the debugging disclosure, Screencast Mode, and
`Always Allow` show a glyph and keep their words on the accessible name and hover card. Visible
words on the bar are reserved for a value (a count, a metric, a branch, a delivery id) and for an
abnormal state (degraded, failed, waiting on the user), and even then stay a word or two; a mode
name such as `Debug port` is neither and only spends rail width.

Persistent metrics use concise icon-plus-value labels; explanatory prose belongs in their
accessible names and hover tooltips. Clickable `StatusItem` and read-only `StatusInfo` both set
figures in `tabular-nums`, so a value that changes on every poll does not nudge its neighbours. A multi-fact status-bar tooltip uses the shared `StructuredTooltip`
layout rather than a newline-joined string: an optional muted kind line, a semibold title, muted
label/value rows (paths and addresses in monospace), foreground state lines, muted notes, and a final
muted `Click to …` hint naming what the chip does. Source Control's repository and group rows use the
same layout, with their modifier gestures as the hint lines. A single-phrase tooltip stays plain text. A status-bar card that lists its own links (the Linear chip's other referenced issues) keeps the same compact look on the PreviewCard surface (`StatusTooltip`), so the pointer can enter it; a link-free card stays a Tooltip. The notification bell is pinned to the far bottom-right corner,
outside the right-hand chip rail, VS Code style: every chip beside it follows the active tab and
comes and goes as the user moves around, so an anchor placed among them would slide sideways, and
the rail's last child is the first thing an overflow hides.

The Workbench Root picker shows branch labels on one line, with directory hints only for detached
or duplicate branch labels and complete paths in shared tooltips. Its compact list pins the current
root, includes the five newest other linked roots, and keeps the Git main worktree reachable with
a `Main worktree` marker. `Show all worktrees…` expands the same popover into the full list.
Unknown creation times sort last, deterministically. An `Authorize` label distinguishes discovered
but unapproved roots; selecting one opens the shared in-app confirmation with its full destination
and `Authorize and switch`. Cancel grants nothing. A `Don't ask again` checkbox at the dialog's
leading edge turns `workbench.confirmWorktreeAuthorization` off only when the user also confirms;
the Settings switch turns the question back on. Approved roots switch directly without Finder.
While the Session is still on its own root and its conversation worked in a linked worktree, the
picker's glyph carries a `--foreground` dot in its top-right corner (drawn into the glyph, so the
chip keeps its width; never `--accent`, because a passive hint must not compete with the one durable
focus of Principle 2) and its tooltip names that worktree. It is a passive hint: clicking opens the same
picker, whose leading `From this conversation` group already offers the worktree. It never opens a
prompt or takes focus. The pull request chip carries the same `--foreground` dot when the pull
request's head branch is not the checked-out branch, names that branch in its accessible name, and
its hover card adds `Switch to <branch> Worktree` (the picker's own switch and authorization) when
exactly one worktree has that branch checked out.

The Workbench Root and branch pickers both open on a focused search field, because a checkout with
dozens of worktrees or hundreds of branches cannot be scrolled faster than it can be typed. Typing
searches the entire set: the compact worktree list and the `Show all worktrees…` row exist to keep
the resting menu short, not to withhold a root from a query the user already entered, so that row
disappears while a query is active. Both fields match contiguous text: a branch, a directory name,
a path segment, never a fuzzy subsequence, since shared branch prefixes and one common worktree
parent directory make every row a fuzzy hit and rank the real answer below noise. An empty query
shows the list unfiltered.

**PrimarySidebar**: flatten the double-box nesting: project groups are a disclosure row
(chevron + Folder/FolderOpen icon + name, no border, no card); sessions are flat rows indented 16px.
The Project row keeps low-frequency metadata out of the resting list: hover or intentional keyboard
focus opens a compact Portal card to the PrimarySidebar's right with the full name, active Session
count, and complete root path. The treeitem's accessible name still includes the Session count, so
moving the visible digit into the detail card does not make a collapsed Project opaque to assistive
technology.
Selection is an `--elevated` fill (radius 6), no border and no accent; the primarySidebar stays
entirely neutral so the focused pane keeps the screen's one accent. A Session row is one 28px line: the Agent
icon, the title, and one right-edge status slot, the same shape as Codex's thread list. The leading
icon is a plain brand-color mark (Claude Code and Codex keep their colors, like every other surface:
workbench tabs, the Session hover card, the MRU switcher, Activity rows, Archived Sessions, Settings,
and menus) because in a long list the color is what tells one Agent from another at a glance; it
carries no lifecycle decoration. The right-edge slot answers "does this Agent need me, or is it
working?" first: running work (including compaction) shows a thin open ring spinning in `--muted`,
as Codex's thread list does, with no color so several working Agents never turn the list into a
wall of green. A Claude turn that ended while background subagents, workflows, or monitors it
started still run is still running, but shows a slower dotted ring in the same `--muted` (Orca's
quiet monitoring sub-mode) so it reads as waiting rather than busy; unacknowledged attention shows a pinging warning ring around a warning dot; a
detached Agent shows a static unplugged glyph. Attention wins over running; there is deliberately no
second, static amber state, so reading a Session is the only thing that clears it and nothing can
bring it back unread. Lifecycle outranks delivery: only a settled Session (idle, unknown, failed,
exited, or read) shows its pull request and production deployment glyph in that slot, and while a
lifecycle glyph holds it the PR stays reachable from the row menu. A visible
glyph claims the 14px slot and every such glyph shares one vertical line; a Session with neither
collapses the empty slot to zero so its title gains one more character while retaining the 8px
separation from the right edge. The MRU switcher shows the same lifecycle glyph after its relative
time, reserving the slot so the time column does not shift.

The row deliberately shows no activity label, relative time, or line diff. In daily use those were
not read, and a second line halved how many Sessions fit on screen. The hover card restates a
non-default status in words. A collapsed Project heading summarizes the rows it hides: a small running arc with
the running count, and one warning dot when any Session is unread; it stays beside the name while the
heading's hover actions show, and disappears when the Project expands. Thus a failed process is not a persistent
list alert, while reliable unread attention remains visible
regardless of its exact kind. Motion and shape carry the glance signal without changing title
weight, and the accessible label plus the Session hover/focus card preserve exact lifecycle and
attention details. On pointer hover, Pin and Archive occupy a reserved cluster at the row's right
edge; the title (and a Pinned row's Project name) clips with the same right-edge fade before that
cluster. Every right-edge glyph (lifecycle, delivery, and Caxri Bot marker) collapses while the
pointer is over the row, so the row shows only Pin and Archive and the title keeps its width; a
glyph that stayed beside the buttons read as a third action and crowded the title. The hover card
still states a non-default status, so hovering a busy row does not hide why it is busy. Keyboard focus keeps
the track visible because Delete already owns the keyboard action; the hover buttons stay outside
the tree's single Tab stop. The Portal
card opens to the PrimarySidebar's right after a short hover delay (or immediately on intentional keyboard focus),
collision-shifts within the viewport, and is a glance: the full title, the primary Agent icon, last active time, and
Project, plus one muted status line (`Working`, `Unread, finished`, `Detached`) only when the row's
status glyph is non-default; a settled Session keeps the two-line card. Removed facts live elsewhere:
the pull request is the row's PR glyph and the row context menu, the creating Session and past
conversations open from the row context menu, and the accessible description still carries the
Worktree, pull request, activity, and unread-attention sentences. Opening a
modal closes the card and gives the modal ownership of Escape. Canceling a picker restores the exact
opening control without reopening its detail card; a command's explicit focus handoff takes precedence.
If the opening control disappeared, restore the current workbench Terminal when available.
All non-archived Project and
Session names and navigation icons use `--foreground`, including inactive rows. Overflowing Session
and Project names clip with a right-edge fade instead of an ellipsis: the ellipsis glyph spends
row width on punctuation. The fade is a 20px mask, about one and a half characters at the 13px UI
size, matching Codex; one character read as a hard cut rather than a fade.
A Project heading's Customize Icon and New Session buttons follow the same hover-cluster rule: at
rest they reserve no width, so the name runs to the row's edge; on hover, keyboard focus, or while
the New Session menu is open the name makes room and fades before them. Hovering New Session lists
the Agents. With a configured default Agent it splits: a press creates the
default Agent (the tooltip names it, `New Codex Chat Session`); without one a press opens the list.
Clipped Session names reveal their tail after a 600ms title hover or keyboard-focus pause, moving
at a steady reading speed and holding at the end. While a title scrolls, its left edge fades in as
text slides under it and the right fade clears once the tail shows, so text dissolves at both edges.
Leaving restores the fade; short names remain still.
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
carries the Session history pair: Back then Forward, ghost icon buttons in `--muted` that lift to
`--foreground` on hover, placed immediately after the traffic-light clearance because that is
where every browser puts them. They are `no-drag` islands in the header's drag region. A direction
with an empty stack renders disabled rather than hidden, so the pair never reflows and its
position stays learnable; the shortcut and command name reach the user through the shared command
tooltip instead of a bespoke label. Archived Sessions use one stable PrimarySidebar footer entry
with a global count: the footer row holds nothing else, so the whole row is one button that reads as
the Session tree's last row (same height, glyph inset, 14px glyph, and `--state-hover` tint): archive
glyph and a short `Archived` label on the left, the count on the right, and a chevron on hover
because it opens a dialog. No divider sits above it; the list's bottom scroll cue marks that edge. A
glyph-only chip left most of the row dead to clicks. Search, filters, Project-grouped results, restore, and delete live in a
full-width management dialog. Its footer carries the jump to Session search as a small ghost
`Search Sessions` button beside `Done`, the Keyboard Shortcuts `Edit Keybindings` pattern, so the
header stays a title plus description. Project disclosures contain active Sessions only, so low-frequency
history never fragments navigation. A disclosure renders its first five Sessions in sidebar order
plus a text-only `Show N more` row (N is the count the next activation reveals, at most ten) that reveals ten more per activation and disappears once the list
is complete, so a busy Project never buries the Projects below it. The row has no disclosure chevron:
it is not a collapsible branch, and a twistie would spend width on a meaning it does not have. Project
and Pinned groups share one `SessionRevealRow`: a 24px, 6px-radius, content-width `--muted` button
whose label starts at the Session title's left edge, so its hover background and focus ring cover only
the label instead of reading as a full-width selected Session row (the Codex app's compact fold). The
selected Session always renders even when it sits below that window. The revealed count is
per-Renderer-lifetime: a relaunch starts from the short list the same way it starts scrolled to the
top. When the Session list has scrolled away from the top, a VS Code-style inset `--shadow` sits
under the header across the list's top edge and clears as soon as the list returns to the start. The
list uses a quiet 8px scrollbar whose thumb deepens on hover instead of expanding into the
macOS overlay track.

Pinning a Session moves it into a global `Pinned` group above every Project and takes it out of its
own Project group. It is one Session, so the sidebar shows it once: two rows for one thing made the
list longer without making anything easier to find, and left every Project count and window
describing rows the group no longer owned. The Pinned row's accessible description opens with
`In Pinned group.` so its owner is still audible, and the row trails the owning Project's name for
the same reason. The group heading mirrors a Project heading (a disclosure and its name) but takes
the `Pin` glyph instead of a folder, and carries no trailing count: the group is short by
construction, and its membership reaches assistive technology through the heading's accessible name
instead. Its rows trail the owning Project's name in `--muted`, allowed to shrink to nothing so a
long Session title still wins the row; without it the group would stack titles from several Projects
with nothing to tell them apart. Pinned is its own list with its own order and its own drag: a fresh
pin lands after everything already there, and unpinning returns the Session to its Project group in
that group's own order. It reuses the Project disclosure's five-row window and `Show N more` row, so
a long Pinned list cannot push every Project off screen. A Project whose every Session is pinned
keeps its heading and shows the same empty-group menu as a Project with no Sessions at all; the
Project is still there, and hiding it would make pinning look like it deleted something. Pinning is
reachable from the row's hover action (the `Pin` glyph, tinted `--accent` while pinned) and from
the row's context menu, which is where the keyboard reaches it, since the hover buttons stay outside
the tree's single Tab stop. Archiving clears the pin, because an archived Session would otherwise
keep sitting at the top of the sidebar; unarchiving does not restore it, since the pin was a separate
decision.

A Session working in a Git worktree rather than its Project root carries no mark on its row: in
daily use a leading worktree glyph added a column without changing what the user did next. The
worktree name stays in the row's accessible description.

Adopting a worktree as a Workbench Root auto-registers a Project for it, and that Project never
occupies a top-level slot in the PrimarySidebar. The list shows the Projects the user added; a
worktree is a property of the Session working in it, which the Session's accessible description
already names. A second top-level row per worktree would double the list without naming
anything new, and no PrimarySidebar affordance (reorder, delete, disclosure) applies to a row the
user never created. The consequence is that such a Project is reachable only through its owner:
deleting the owner deletes it, and the confirmation names the ones about to go.

Pull request lifecycle owns the glyph color: open is `--success`, closed is `--danger`, merged
is `--merged`, and draft is `--muted`. Never overlay a badge on the small PR glyph or recolor it for CI. The existing animated
yellow Session attention ring keeps its separate meaning in the row's right-edge slot. A production
deployment that succeeded uses the rocket in `--merged`: shipping is where a merged pull request goes
next, and a green rocket read as the same state as an open PR.

The Status tab carries a compact, static badge anchored to the heartbeat icon's lower-right
corner, following VS Code's activity-bar badge placement. Use a 16px minimum circular surface that
grows into a capsule and a surface-colored ring separating it from the icon. The tab reports a
severity, so the badge is the Workbench's error glyph on `--error-badge`, never a digit. It fires
on failed PR checks and current production/preview deployments across the selected Session's
repositories, deduplicated by identity; PR rollups, historical deployments, pending work, and
provider-fetch errors do not raise it. Zero or unavailable status hides the badge; tooltip and
accessible description expose the full count and categories. Switching tabs does not clear
failures; switching Sessions changes the badge scope.

Badges are an extension view capability, and an extension reports only meaning: a plain-text
description plus one of `count`, `error`, or `warning`. Appearance is the Workbench's, so two views
can never paint one container in two unrelated colors. A `count` badge is a digit on
`--badge`/`--badge-foreground`. An `error` or `warning` badge is a fixed Workbench glyph, never a
digit, on `--error-badge` or `--warning-badge` with their derived foregrounds, so severity survives
greyscale and color blindness; the two glyphs differ in shape, not only in fill. Those two roles are
separate from `--danger` and `--warning`, which are text colors imported from the editor's error and
warning squiggles and are not fills.

Within a container, severity takes the badge outright: `error` beats `warning`, and either beats
every tally, which then does not appear on the chip at all. Only `count` badges are totalled, capped
at `99+`; severities are never summed, because a severity carries no count. A glyph and a digit never
share one chip: the digit would displace the glyph and leave the fill as the only difference between
`5` changes and `5` failures, which is nothing to a colorblind user or in a greyscale capture. This
is VS Code's rule: its composite-bar badges are a strict `progress` > `icon` > `number` ladder, and
its `ErrorBadge`/`WarningBadge` have no number field. Git counts all working-tree changes across the
current Workbench Root's repositories, including hidden and truncated entries. Every contributing
view's description reaches the accessible description and the tab tooltip whatever the chip shows, so
a displaced tally stays announced and stays hoverable. Badge reads activate declared providers even
before their views open. Zero, no selected Session, and unavailable extension states hide the badge;
counts never carry across Workbench scopes.

**Trees**: a tree is `role="tree"` with `role="treeitem"` rows, and the role sits on the element
that takes focus, never on a layout wrapper around it: `aria-level`, `aria-selected`, and the roving
`tabIndex` have to describe the thing the user is actually on. One tree is one Tab stop: exactly one
row carries `tabIndex={0}`, the row focus would return to, and every other row carries `-1`, so Tab
enters the tree once and arrows move inside it instead of walking every row in the document. In a
virtualized tree that row stays mounted wherever the list is scrolled (`virtualTreeRenderedIndexes`):
a wheel scroll moves the window, not the Tab stop. A disclosure chevron beside a row is a pointer
target only: it is `tabIndex={-1}`, and a click on it hands focus to its row, so it never becomes a
focus owner the arrow keys cannot leave. A row being renamed is the one allowed exception: it keeps
its `treeitem` role and hands its `tabIndex` to the input inside it for as long as the edit lasts.
A tree driven from a field the user is still typing in is the other: there the rows are all
`tabIndex={-1}`, the field keeps focus and carries `role="combobox"` with `aria-controls` and
`aria-activedescendant`, and that attribute is what names the current row. This is the standard
combobox pairing, not a second focus model; a tree may adopt it only when a field owns the tree's
whole navigation, never as a way to avoid giving rows a roving Tab stop. Anything that is not a row
lives outside the tree element (an empty-state action, a live region) because inside
`role="tree"` a focusable element has to be a real row holding that single Tab stop, and a static
notice is not a row. The corollary runs both ways: a "show more" control renders _inside_ the tree
as a real row, because it is focusable and
therefore cannot be anything else. The one notice that cannot be lifted out is a lazy branch's
in-place placeholder (loading, error, empty). It renders where that branch's children would, so it
stays a `treeitem` (`aria-disabled`, never focusable, wrapping a `role="status"` region so its
arrival is still announced), and arrow keys step over it to the next real row rather than parking
focus on text. Right on an already-open branch whose first row is a placeholder does not step into
it for the same reason: there is no row there to land on yet. Focus and hover are different states and never share a fill: hover is the
pointer's guess, focus is where the keyboard is, and a tree that paints them identically leaves a
keyboard user unable to see where they are. Which fill each tree draws still follows its surface:
the PrimarySidebar's neutral rule means its focus ring is `--foreground`, not the accent the
workbench's own trees use.

**Treegrids**: a table whose rows nest is a `treegrid`, not a `tree`: sortable `columnheader`s and
several data columns per row are only legal under a grid, and a `tree` would flatten them into one
label. It follows the tree rules above with the row itself as the focus target: one roving Tab stop
across all rows, arrows to move, Left/Right to collapse and expand, and a leaf renders no control
of its own, because a row that is already focusable does not need a button inside it to be reached.

**One tab level**: the Workbench has a single 36px horizontal row, the focused pane's tab bar, which
is also the window's title bar (`--title-bar-*` fill, drag region, traffic-light inset). There is no
Session tab level: the PrimarySidebar is the Session switcher, so switching Sessions never adds or
removes a row and the content below never jumps. A Session's title therefore appears on its sidebar
row and nowhere else in the chrome. The sidebar marks a row another window shows with an 11px
`--muted` window glyph after its title, never `--accent`; a title that collides with another
Session's gets a trailing 11px `--muted` detail (Project, Agent, or `#n`). Holding the Switch to
Pinned Session modifier alone for 400ms swaps each Pinned row's status glyph for a compact
`ShortcutBadge` with its live chord (`⌘1`), hidden on row hover like the glyph it replaces; releasing
the modifier or pressing any other key restores the glyph. "Open in New Window" in the sidebar row
menu is the way to see two Sessions at once.

**Tab strip**: active tab: `--background` fill joining it visually to the pane below,
`--foreground` text, and a 2px `--accent` top border, VS Code style. Inactive: `--surface` +
`--muted`. The active tab always shows its close button; an inactive tab reveals a `--muted` one
only under the pointer or keyboard focus, VS Code style; hunting for a control that is always
there on the tab you are working in is the friction this removes, and keeping the inactive ones
muted is what stops a crowded rail from reading as a row of X's. A dirty tab shows its dot in that
slot instead and swaps to the close button on hover/focus, active or not.
Tabs fill the full 36px rail height. Document tabs fit their full labels; Terminal tabs divide the
remaining width with their full displayed content as the minimum. Crowded bars scroll rather than
truncating Terminal labels or imposing a fixed filename cap; the one exception is a single document
label longer than the whole bar, which truncates 6rem short of it so its own close button stays in view.
That cap never drops below 8rem: in a narrow editor group the strip scrolls instead of cutting every
title to a few letters.
While the whole workbench holds exactly one tab across every
pane, that tab drops the accent top border: an "active" marker distinguishes nothing when there is
nothing to distinguish it from, and the pane ring still carries focus. The New Terminal + reserves
no slot then: it floats over that tab's trailing end, revealed on bar hover or keyboard focus, and
collapses its width at rest, so the tab's fill reaches the bar's edge instead of leaving a block of
bar color beside it. Hovering + still opens the Agent list, where each Agent row carries one muted
suffix (`Chat`, `Default`, or `Chat · Default`) and the foot toggle reads `Always Open Agents in
Chat`, the same as in the New Session menu. Pressing it (pointer click or keyboard activation) instead creates a Terminal
running whichever Agent the Session's own primary Terminal is currently running, so the press clones
the conversation already in front of the user instead of asking again; that icon's tooltip names the
Agent and surface it will create ("New Codex Chat", "New Claude Terminal") and shows ⌘T only
when `terminal.new` would create that same Agent on the same surface: a press that clones a live
Agent other than the default gets no shortcut chip, which would promise what ⌘T does not do. It falls back to `session.defaultAgent`
when that primary Terminal is a plain shell or has exited, and to opening the Agent list (with no
tooltip, since there is nothing yet to name) when neither resolves. Either way the chosen Agent
starts as another Terminal in the same Session. With two or more tabs, + stays visible and keeps the
same behavior. An Agent tab's Terminal | Chat toggle (`Open as Terminal or Chat`) is always visible
while the active tab can switch, quiet at rest and full strength on bar hover, focus, or while a
switch is pending. At rest only the pressed segment's icon dims to `--muted` like its neighbour;
the control is never faded with opacity, which also faded its track and thumb, the only edges that show it is one
control. The selection is a raised `--elevated` thumb on a borderless `--state-track` that slides to the open surface
over `--motion-chrome-switch` once the switch lands; segments never take a fill of their own, so a hovered segment only
brightens its icon and never reads like the selected one. The + sits before the toggle, next to the tabs, so revealing it on hover grows the strip
toward the tabs and never moves the toggle out from under the pointer. An external file whose name repeats among the Session's open external files shows the
shortest parent path that tells it apart in `meta` `--muted` after its label (VS Code's tab
description), and every external tab tells a screen reader it is `Outside every Project`. An empty pane uses its own labelled action, reading New Chat when it will create a
Chat and New Terminal otherwise.
A clean preview Editor owns one transient, Session-scoped motion identity: replacing its path
updates the same DOM tab instantly, pinning preserves that identity, and only the next real tab
receives the existing enter animation.
An active ordinary file with committed history keeps two fixed ghost icon actions at the right of
its pane's tab rail: `Open Last Commit Changes` shows the latest commit that touched that file, and
`Open Pull Request Changes` shows the file's committed current-branch PR diff. They use distinct
commit and pull-request glyphs, remain keyboard reachable and outside the scroll rail, and hide for
Terminal, external, transcript, and Git diff tabs. These file actions remain when the Editor is the
only Workbench tab; the single-tab rule above still hides only the active accent at rest.
Single-file Git diff tabs use the same action slot for `Previous Change`, `Next Change`, and
`Open Current File`. Navigation targets that pane's mounted diff and stays disabled until changes
are ready. Every Git diff tab, single-file or multi-file, ends that slot with a `Diff View Options`
ellipsis popover holding `Inline View`, `Collapse Unchanged Regions`, and
`Show Leading/Trailing Whitespace Differences`. These are window-lifetime view preferences, not
persisted settings, and they are deliberately not mirrored into Settings: they are read-and-adjust
controls that belong beside the diff being read. `Collapse Unchanged Regions` starts at each
surface's own default (collapsed for a multi-file diff, expanded for a single file) and only
becomes one shared value once the user sets it. Ordinary file and single-file diff tab menus offer `Copy Path` and `Copy Relative Path`;
relative paths measure from the Workbench Project root, so one file yields one path wherever it is copied from: the
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
chrome. This does not govern the Session list's running ring.

**Git decorations**: a file with working-tree changes reads the same wherever its name appears.
The name takes the `--git-*` color of its change, and a single status letter (`M`, `A`, `D`, `U`…)
sits at the trailing edge of the row or tab in the same color: the Files tree, the tab strip, and
the diff headers all render that letter from one component. Source Control resolves the same roles
from the same table by reading its decoration's `identifier` back as a change kind; the Extension
API's generic `tone` survives only as the fallback for a provider that is not Git, because three
tones cannot hold five roles. The staged column
wins when both are set, so a file staged as added and then edited reads `A` everywhere. The file
type icon keeps its own color: it identifies the language, not the change. A directory in the Files
tree takes the color of the most severe change anywhere beneath it (conflicted, then deleted,
modified, renamed, added, untracked) but no letter, which would claim the folder itself changed.
Changes inside a submodule or a nested repository decorate that child repository's root and keep
climbing through its ancestors, stopping below the selected Workbench Root's own repository root:
its main checkout or a linked worktree, whichever the Workbench Root is. Only that one root is
excluded; a child root is a decoration the user can act on, not a boundary. A child root a parent repository reports as a moved gitlink is still a folder row, so it
takes the louder of that change and whatever is inside it, and still no letter. A directory's color
says there are changes under it, not that the enclosing repository tracks them. Inactive tabs keep
their decoration color; the point is to be readable across the whole rail without selecting each
tab. Ignored entries stay muted and italic and take no decoration. The decoration is visual only: a
row or tab is still named by its bare filename, and the status reaches assistive technology as an
accessible description (`Git: modified.`) rather than being folded into that name.

**Child repositories**: a directory that is a repository of its own takes the glyph Source Control
and Project Status give that repository in place of a folder icon: the `archive` codicon for a
submodule, `repo` for a directory someone cloned in independently. A neutral folder wearing a small
Git badge still read as one more folder among `docs` and `e2e` and did not say which kind of
repository it was; the shared glyph names the kind and ties the row to the same repository's rows in
the other two panels. The row's tooltip and its accessible description also name the kind, since only
the submodule shows up as a change in the parent when its recorded commit moves. A linked worktree
takes no mark: it is a peer checkout, not something nested in this tree. The mark is independent of
the change decoration above: a submodule or nested-repository root can carry the glyph and a change
color at the same time, and still no letter.

**Editor breadcrumbs**: an ordinary Project file gets one 24px metadata row below the tab strip.
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

A document the Project cannot browse keeps the rail and loses the interaction: a file authorized
from outside every Project root shows its full absolute trail, and a diff shows its
repository-relative one. Neither takes a tab stop and neither opens a picker, because there is no
authorized directory listing behind a segment: a clickable segment there would promise navigation
the Renderer cannot perform. The metrics, icon placement, and horizontal scrolling match the
interactive rail exactly, so switching between a file and its diff never moves the first line of
content. An external file gets no last-change annotation: blame needs a Project-scoped repository.

**Scroll edge cues**: a scroller whose content continues past an edge that meets fixed or
floating chrome marks that edge, and only while content is actually hidden there; at rest at the
edge the cue is gone. This is one rule for every scroller, not a per-surface addition, and a new
scroller picks one of the three sanctioned cues instead of hand-rolling a gradient:

- A list scrolling under its own header (the PrimarySidebar Session list, Files, Source Control,
  extension trees, Activity) wears the VS Code-style 6px inset `--shadow` on its top edge, and the
  mirrored shadow on its bottom edge while rows remain below: `.scroll-edge-shell` around a scroller
  bound with `useScrollEdge`.
- Content that runs on under floating chrome (the Agent Chat transcript and task output under Jump
  to latest) or past a sideways edge (pane tab strips, wide report tables) dissolves into a
  `ScrollFade` gradient toward the fill it sits on: 40px for a vertical edge, since a shorter fade
  over 20px lines reads as a cut line, and 24px for a sideways one. Vertical fades stay inset off
  the 8px scrollbar rail. Reference: the Codex app's transcript fading into its composer.
- A scroller nested in content whose background varies (a Chat work group's capped list) masks
  its own edges with a `mask-image` gradient instead, since no single fill matches what is behind it.

Never end a scroller above floating chrome to keep it from overlapping: the blank band that leaves
reads as the chrome hiding the conversation. Let the content run under the chrome and fade. The
Chat's return hint is the one exception: it shows only while the latest entry is in view, where
nothing is left to scroll under it, so the transcript ends above it rather than covering the last line.

**Motion**: motion explains structure; it never decorates state. Motion is a layered stack. Pick
the least-powerful layer that covers the scenario, and one element is only ever driven by one
layer:

1. **shadcn overlay layer** (`tw-animate-css` classes from `components/ui/overlay-motion.ts`, the
   one source every `components/ui/*` popup composes): dialogs, selects, dropdown menus, popovers,
   tooltips, preview cards, and future shadcn components. Anchored popups fade, zoom from ~95%
   at `--transform-origin`, and travel 4px away from their trigger along Base UI's `data-side`;
   tooltips fade and travel 2px without zooming, since a zoom blurs one line of small text;
   dialogs fade and zoom from the center. Exits only fade and shrink. Base UI's instant phase
   (`data-instant`: sweeping between adjacent tooltips, a keyboard-opened trigger, an Escape dismissal) shows and
   hides without animation so a toolbar sweep never flickers. All of it is gated by Base UI popup
   state attributes. We
   deliberately do not import `shadcn/tailwind.css`: its custom `data-open`/`data-closed` variants
   exist to bridge Radix and Base UI, and this repo is Base UI–only, so native Tailwind attribute
   variants are equivalent (see upstream debate in shadcn-ui/ui#10267).
2. **Native CSS** (`interpolate-size: allow-keywords`, height `0 ↔ auto` transitions): every
   user-triggered section disclosure: PrimarySidebar Project, Files search groups, Git
   repository/history, Project Status sections. The measured SecondarySidebar/Panel
   chrome tab indicator also uses a native transform/width transition, but only for a move to
   another tab of the same owner: a Session switch (each Session keeps its own container), the
   first placement, and a resize put it in place at once.
   `components/disclosure-motion.tsx` is the thin presence wrapper: it mounts content in the
   commit that flips `data-expanded` and releases collapsed DOM once the height transition
   settles, so collapse never retains hidden queries, watchers, or large subtrees.
3. **auto-animate** (zero-config list add/remove/reorder): deferred, not installed: its React
   StrictMode add-animation bug (formkit/auto-animate#232) is unfixed as of 0.10.0 and both
   renderer entries enable StrictMode. Until it lands, simple lists stay instant.
4. **Motion** (`motion/react` via `LazyMotion strict` + `motion/react-m`, `domAnimation` features
   only): fine presence/timing control and future layout math: the work tab strip's enter/exit
   (opacity plus width), future drag reorder and shared-element transitions. Its easing comes
   from the same tokens through `motionEasing` in `lib/motion.ts`, never a library preset.
5. **NumberFlow** (`@number-flow/react`, only through `components/animated-number.tsx`): a live
   figure whose changed digits roll to the new value behind an edge fade, used only for the live
   Agent Chat figures below. `AnimatedNumber` sets its timings from `--motion-number-roll` (600ms,
   `--motion-ease-emphasized`) with characters fading on `--motion-overlay-enter`, never
   NumberFlow's own spring, and reads reduced motion through `useShouldReduceMotion`. Only a change
   after the figure held still for 1.5s rolls; a figure changing faster (seconds, streaming tokens)
   jumps, so the strip never stays in motion.

Timing lives in the `--motion-*` tokens in `styles.css` (`:root`): the single source for CSS
transitions, tw-animate durations, Motion transitions, JS presence-cleanup fallbacks, and tests:
disclosures expand `--motion-expand` (180ms, `--motion-ease-emphasized`
`cubic-bezier(0.25, 1, 0.5, 1)`) and collapse `--motion-collapse` (130ms, exit curve); work tabs
enter `--motion-tab-enter` (140ms, enter curve) and exit `--motion-tab-exit` (110ms, exit curve); the
shared chrome tab indicator and the PrimarySidebar's selected-row fill move with
`--motion-chrome-switch` (160ms, `--motion-ease-emphasized`), the row fill as one ghost gliding from
the previous row while the Workbench content switches instantly; overlays enter `--motion-overlay-enter` (150ms) and exit
`--motion-overlay-exit` (100ms); `Compacting` pulses on `--motion-compaction-pulse` (1800ms,
ease-in-out); live Agent Chat text sweeps on `--motion-activity-shimmer` (2200ms, linear), or by default sweeps on
`--motion-activity-dwell-sweep` (1400ms) and rests for `--motion-activity-dwell-rest` (2600ms); loading
skeleton blocks pulse on `--motion-skeleton-pulse` (2000ms, ease-in-out) after fading in on
`--motion-overlay-enter`; live figures roll on `--motion-number-roll` (600ms); a phrase joining a Chat work
summary fades in from a slight blur on `--motion-summary-phrase-enter` (320ms, enter curve); a streaming
Agent Chat reply fades in on `--motion-text-reveal` (500ms, linear). JS resolves tokens
through `lib/motion.ts` (`motionDurationMs`);
settlement fallbacks are token plus a safety margin (`motionSettleTimeoutMs`), never an independent
literal. The enter curve `--motion-ease-enter` is easeOutQuint `cubic-bezier(0.23, 1, 0.32, 1)`,
which answers the pointer in the first frames instead of the keyword `ease-out`'s slow start;
exits use the accelerating `--motion-ease-exit` `cubic-bezier(0.4, 0, 1, 1)`. State feedback
(hover color, hover-revealed row actions, focus rings, switch and checkbox) runs on
`--motion-feedback` (120ms, enter curve) through Tailwind's `--default-transition-*` variables,
so a bare `transition-*` utility is already on-token: never add a literal `duration-<n>` or
`ease-in`/`ease-out` utility. Motion that can run for longer than a transition must stay cheap
while nothing new is happening: spin or pulse an HTML wrapper with `transform` or `opacity`, never
an inline `<svg>` root, which Chromium animates on the main thread (`RunningArc`); end a decorative
loop after a few iterations and replay it on a real trigger instead of looping (the attention
ripple); and never hold a still phase inside the keyframes of a property such as
`background-position`, which restyles every frame of the hold, but end the animation and restart it
after the rest (the dwell shimmer). A hidden Workbench Session skips style updates, so motion left
in it never settles: its running CSS animations are paused and its transitions cancelled after it
hides, and the paused ones resume on return (`features/workbench/hidden-session-transitions.ts`; a
descendant `[hidden] *` CSS rule is not used because it restyles the whole subtree on every switch). See the `performance` skill for how to measure idle cost. The Terminal and Agent Chat find bars fade in (the floating
Terminal bar also drops 4px) and close instantly; the pane split drop preview fades in once and
then glides between zones on `--motion-chrome-switch` so the target split stays legible. Sending a
Chat message flies each attached image from the composer into its tile in the pending message on
`--motion-image-send` (280ms, `--motion-ease-emphasized`), up to four images and only between
on-screen ends. Each flies as a detached clone the Web Animations API moves while it follows its
tile every frame (`features/agent-chat/composer/send/agent-chat-sent-image-flight.ts`), not as a
View Transition: the browser skips a transition once a captured element stops rendering, and the
pending row gives way to the accepted message within the flight.
The Agent Chat composer's attachment row follows its content's height (`useContentHeightTransition`):
it expands on `--motion-expand` when the first image or file arrives and collapses on `--motion-collapse`
after the last one leaves, while each attachment fades in from 92% on `--motion-overlay-enter` and, when
removed, fades and gives back its width on `--motion-collapse`. Attachments restored with a draft appear
without motion, and the transcript keeps its scrollbar hidden while the composer resizes it.

Intentionally instant: initial bootstrap/restore, Session switches, tab-panel activation, Agent
state transitions, the Agent Chat composer strip and its rows appearing or leaving, Session hover
cards closing (and swapping as the pointer moves from one row to the next; the Project card keeps the ordinary delay and motion), sidebar and Panel visibility (animating their width would reflow every
xterm on each frame), Project drag settlement, folder glyph changes, Terminal panes/output, data refreshes, and tree-item
disclosures in Files, Source Control, and extension-contributed trees. Do not stagger rows or neighboring tabs.
The Process Explorer window is out of scope (separate style layer, diagnostics; see `docs/process-explorer.md`).

The Session status icon is the narrow state-motion exception: unread attention pings so a newly
actionable event is noticeable, and running spins an arc around the Agent icon. Amber pings three
times when the event arrives and three more times whenever the window regains focus, then holds
still: the ripple's job is to be noticed, the amber color already marks the row once it has been,
and an endless ripple kept the Renderer and compositor busy for as long as a Session waited. An
unread event is the only thing that colors the Agent icon, so the still amber dot never competes
with it; the collapsed Project heading's static warning dot summarizes the same rows. The
motion belongs to the ring, never the Agent mark itself; swapping among the three list projections
remains instant.

A streaming Agent Chat reply is a content-motion exception, as in the Codex app: each run of
characters the stream pacer adds fades in from transparent (`.text-reveal`,
`components/markdown/revealing-text.tsx`), so the tail of the reply reads as a short gradient instead
of hard-edged typing. Text the reply already held when it mounted (a Chat opened mid-stream) shows at
once, a settled reply renders plain text, and reduced motion shows every run at once.

The work-tab `Compacting` accessory is the other state-motion exception: only that word pulses,
while the Agent icon, Session title, focus accent, and neighboring tabs remain still. Live Agent Chat work is the third: a highlight sweeps across the text of what is still running
(a running tool's whole title, verb and subject together, `Thinking`, the composer's working line)
through the `.activity-shimmer` class. By default (`agentChat.statusShimmer: dwell`) the sweep crosses
once, linearly, in the first 35% of `--motion-activity-dwell` (4000ms, about 1.4s) and rests for the remainder, so a long turn
is not under constant motion; `continuous` keeps the linear 2200ms sweep and `off` holds the text still.
The row's tool glyph never swaps for a spinner, so a column of rows does not flicker as each starts and
ends; instead a row the user watched run acts out its tool while it runs (a bookworm inching along a
book for a read, a hopping lens for a search, a typewriter for a new file, a snail for a wait; one
16px glyph per tool kind in `features/agent-chat/loading/glyphs/`, `agentChat.animatedToolIcons`),
then settles to its still icon with a one-shot stamp, or a small shrug when it failed (the trailing
status glyph alone carries the failure color). The composer's live figures roll their changed digits
(the NumberFlow layer): the running turn's elapsed time, which rolls forward like a clock, its
steps, tokens, and cost, and the context ring's percentage, so a climbing count reads as progress
rather than flicker. Other figures, including settled history and the Usage page, change in place.
Rows that were already settled when they mounted stay
still. With Buddy chosen, Buddy also replaces the composer status line's spinner and acts out the
turn's current tool (reads with its eyes sweeping, runs with a jog and a drop of sweat, yawns once one
tool has run for 30 seconds), smiles with a heart when hovered, and wears a party hat in about one turn
in fifty, picked from the turn id so it stays for the whole turn. Buddy moves like a flip book: its
loops step on a shared tick rather than easing at the display's refresh rate, 12.5fps for ambient
motion (bob, glance, bubbles) and 25fps for the motion that carries a mood (the reading sweep, the
jog), both halved on battery, and it holds still in a window without focus. These are character exceptions to
"motion never decorates state", kept to the live turn: nothing in settled history moves. Hovered or
keyboard-focused clipped sidebar titles may scroll solely to reveal their text, as described above.

`prefers-reduced-motion: reduce` completes every layer instantly: overlay keyframes are gated
behind `motion-safe:` variants (the library ships no media query of its own, and a
`motion-reduce:animate-none` override would lose the specificity fight against the `data-open:`
attribute variant), disclosure CSS zeroes its durations, Session status icons keep their base shape
but stop moving, the `Compacting` word stays high-contrast and static, Chat shimmer text stays still, live figures change in place, Chat tool glyphs show their still icons and Buddy holds its resting face, and Motion durations come
from the shared `useShouldReduceMotion` hook
(`hooks/use-should-reduce-motion.ts`, the only sanctioned way to read the preference in JS),
without changing focus, selection, command, query, or lifecycle behavior.

**Panel captions**: every SecondarySidebar panel wears the same caption row: 34px tall, bottom
hairline, and a small bold uppercase title with `tracking-[0.04em]` in `--foreground` (VS Code's
section caption). One shared `PanelHeader` owns it, so a Project name, `Source Control`, and
`Project Status` read as one system rather than three. The caption title carries no icon; the
owning tab already shows one two pixels above, and repeating it there is the duplication this rule
exists to prevent. Trailing toolbar actions may be hover-revealed, but only where the caption row
has free space; an action that would sit on top of live text takes its own slot instead. A
destructive action is never easier to reach than the narrower action it dwarfs: where a row's own
`Discard Changes` is hover-revealed, the group's `Discard All Changes` is hover-revealed from the
same rule, the way VS Code reveals both from one selector (`scm.css`, `.resource-group > .actions`
beside `.resource … > .actions`).

**Background refresh**: a panel that re-reads its own data never stops taking input while it does.
The widget being refreshed carries `aria-busy`; `inert` is not a refresh state, because it drops
focus to `<body>`, loses the roving position, and makes arrow navigation skip the whole widget for
as long as the read lasts. An action bound to a revision the refresh may invalidate is refused at
execution time with a readable reason, not disabled in advance: a control that vanishes and
returns several times a minute is harder to use than one that explains itself once. Inside a
`role="tree"`, every focusable element is either a real `treeitem` holding that tree's single
roving Tab stop or lives outside the tree; the one exception is a text field, which a `treeitem`
may contain but cannot be.

**Content placement**: the SecondarySidebar holds hierarchical, navigable surfaces that read well
in a narrow vertical rail (Files, Source Control, Project Status). Stream- and record-shaped
surfaces that want horizontal room live in the Panel instead (Logs, Info), which docks under the
work surface inside the centre column so the PrimarySidebar and SecondarySidebar keep full height,
VS Code's PrimarySidebar-vs-Panel split. The Panel is closed at rest, its tabs sit left at their
natural width, and a trailing close button dismisses it. `Command+J` toggles it. A new surface
picks its region by content shape, not by which region has room left.

**Project Status rows** spend their trailing text only on what asks for attention. A branch that
matches origin says nothing (`Synced` stays on the hover badge); a deployment row names its
environment and whether it is the latest, not its short SHA; an acceptance row reads `2/2 · r3`, with
the round spelled out on the hover and in the accessible name.
A pull request row's inline merge is one click when every check passed, with no confirmation, by
design; on the phone, where a bottom sheet is easy to mis-tap, even a ready merge confirms on a
second page that names the merge method and that it cannot be undone. Any other blocker confirms first, and failed checks are named in it (`2 of 9 checks failed:
lint, e2e.`). The merge glyph's tone grades the blocker: `--danger` for failed checks, `--warning`
for branch protection or a stale base, neutral for checks still running or a mergeability GitHub has
not computed. A draft or conflicting pull request keeps the button, which explains why GitHub cannot
merge it and offers Open on GitHub. An inline action whose tooltip carries state (a blocked merge's
reason) opens that tooltip on keyboard focus too; a plain action's tooltip stays hover-only.

**Project Status hover**: every row in the tree wears the same card, so one panel never mixes a
structured card with a multi-line grey string. The card follows the VS Code reference hierarchy:
the row's subject plus its semantic status in the heading, then prose that explains that heading,
then compact `label: value` rows. A repository names its branch and remote, a branch carries an
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

**Project-wide provider failures**: a failure that belongs to the account rather than to one
repository is stated once at the Status root and dropped from the repository subtrees: a lost
connection, and an API budget every repository draws on. A Project holding a repository and its
submodule otherwise printed the same account-level sentence twice, each with its own button. A rate
limit is a wait rather than a fault, so it takes the hourglass instead of the danger tone, names the
clock time Caxri resumes, and shows no action while that pause is still running; the retry it would
offer is exactly the request the limiter is refusing. It keeps one row per provider, because each
budget resets on its own schedule. The update check is the deliberate counter-example: its
pause is local bookkeeping and a manual check is defined to bypass it, so that surface names the
resume time and keeps the action live, because there the button is not the request being refused. The status bar's pull-request chip follows the same rule: it names
the reason it has no pull request to show (`PR rate limited`, `PR needs login`, `PR offline`) rather
than the single `PR unknown` that was true of all eight reasons and useful for none, and its hover
card carries the full recovery sentence.

**Chrome tabs**: the moving underline is derived from the tab slot, never from the label inside
it: inset 8px on each side, capped, and centred in the slot. In the SecondarySidebar's evenly
divided rail every mark is therefore the same size, so it reads as "this region is selected"
instead of tracking a word whose length is incidental, and a responsive tab that drops its label
keeps its underline unchanged. The inset and the cap are what keep an even division from reading
as a segmented control: a mark that runs slot edge to slot edge on a 600px rail is a filled bar,
not an underline.

**Iconography**: an icon names what a thing _is_, never which mode a surrounding control is in. A
glyph reused for two meanings on one screen is a bug: the Git tab keeps the branch mark, so the
Source Control caption drops it, repository rows take a repository mark (`FolderGit2`, or the
vendored `archive` codicon for a submodule) regardless of panel mode, and the mode switch's
working-tree segment takes a diff mark. The Settings tab takes the gear (`Settings`) because
`SlidersHorizontal` is the Settings page's own UI view switch; the Agent status tab and the `tok/s`
chip share `Gauge` because they show the same measurement. Where lucide has no equivalent glyph, vendor the VS Code
codicon inline (`apps/desktop/src/renderer/src/icons/codicons`) rather than bending a lucide icon
to fit.

**Git secondarySidebar**: every discovered repository is an independent disclosure node, with its
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

File and folder rows do not open a hover tooltip: the path is already the row's accessible name, and
a cursor-anchored card over the adjacent diff is worse than a truncated label. Repository rows and
group captions still carry the hover text their own width cannot: branch, and in Pull Request mode
the pull request Command-click opens in the default browser. A repository whose only content is one
group (Pull Request and Last Commit modes) folds that group into its own row: the caption repeated
what the row and the mode switch already said, and its actions join the repository row. Working-tree
mode keeps the `Changes` caption, which separates the changes from the history below. Option-click is
the panel's modifier gesture for recursive disclosure there: on a repository row, a group caption, or a
folder row it expands or collapses everything below instead of just that row. A file row keeps
Option-click's other meaning instead: it skips the row's default and goes to the thing itself,
opening the working file rather than its diff. A file or folder row that offers a modifier gesture
advertises it through `aria-keyshortcuts` without spending a tooltip on it. Trailing Discard actions
and the panel header keep their tooltips. A deleted file has no working copy left, so it keeps the
diff activation only.

A submodule the panel already lists as its own repository section does not also appear as a gitlink
row in its parent's change list; the section carries the same submodule with its branch and its
real file changes, so the row is pure duplication, and every count the parent's caption prints drops
it too. A submodule the snapshot is not showing separately keeps its ordinary gitlink row.

**Uncommitted work in a non-working mode**: Last Commit and Pull Request replace a repository's
file list with that commit's or that pull request's files, so a repository holding uncommitted work
renders identically to a clean one. A mode that answers one question must not silently answer a
different one, so the repository row states the count it is not showing (`· 3 uncommitted`) and
carries a diff-mark button back to Working Tree Changes. Both disappear at zero rather than sitting
there reading `0 uncommitted`. Pull Request mode also compares the local HEAD directly with the
validated remote pull request head, and states any commits absent from that pull request as
`· 2 unpushed`; its tooltip explains that those local commits are not included in the pull request.
This count never borrows the branch's tracking-upstream state, which can point at a different ref.
A repository with no pull request keeps the heading
`Pull Request Changes` in Pull Request mode: leaving it at `Changes` made its zero read as a clean
working tree instead of an absent pull request. A repository row is one line: the folder name, its kind, and its
counts. The branch (or whatever reference the provider describes) is the section's first child row,
its glyph in the group captions' chevron column, so a long worktree name and a long branch each get
a full row instead of ellipsizing each other. On the primary repository, activating the branch row
opens the branch picker like the status bar's branch item, and clicking its `↑2 ↓1` badge runs sync;
a treeitem cannot nest a button, so the keyboard reaches sync through the row menu and the header's
Sync button. Counts are `shrink-0` after the name, which ellipsizes first rather than pushing them out
of the row. A `+N -M` stat drops a zero half beside a non-zero one (`+3`, not `+3 -0`) and keeps a
lone `+0` when both are zero, so the column never goes blank on a changed row.

**Git diff exclusions**: `git.diffExclude` hides matching repository-relative paths from Git
change lists and from `Open Changes`; it ships filtering test files out by default, because a
review of "what changed" almost never opens with them. A default that hides work is only honest if
the surface says so and offers a way back, so hiding is never silent. The Source Control header's
eye button, which reveals the excluded files in place, appears only when exclusions are actually
hiding something: a control that toggles nothing but is always on screen teaches the user it is
decoration. In a multi-file diff tab the hidden count is stated in a `role="status"` notice
carrying two ghost buttons: `Show them` reopens the same aggregate diff with exclusions revealed
and retires the occurrence it replaces, so the user is never left with two identically labelled
`Changes:` tabs, and `Edit exclusions…` opens Settings scrolled to the `Excluded Git diff files`
row rather than to the top of the list. Both buttons name themselves to a screen reader through the
notice they sit beside. Showing excluded files lives in the tab's resource path, not in component
state, so the revealed view is an ordinary diff tab that survives restore.

**Terminal panes**: the focused pane keeps the accent inset ring (with the active tab's top
border it forms the screen's one accent focus). The xterm viewport and scrollbar are full-bleed at
the right edge; top/left text padding belongs to xterm's content box so it never creates an outer
scrollbar gutter. Exited Terminals keep their final output and reserve a compact recovery row
beneath the xterm viewport, never over it. A zero exit without a signal is `--muted` / neutral
(`Process exited normally`); startup failures, signals, and non-zero exits use `--danger` text
and the matching human failure label. Surface actions, the command palette, and
`Command+Shift+R` restart the same durable Terminal record.

**Dialogs**: backdrop `--overlay` + `backdrop-filter: blur(2px)`; content radius 8, border
`--border`, shadow from `--shadow`. Never a close X inside the command palette. Pickers are the one
exception and use a second, named scrim: fully transparent, no blur, still capturing pointer events
so an outside click dismisses the picker instead of reaching the control underneath. A picker is
something the user reads the workbench through while choosing a destination in it, so dimming the
thing they are aiming at defeats the surface.

**Command palette**: rows show command title left, `kbd` shortcut hint right (render from live
keybindings, `badge` size, `--elevated` chips). Group headings stay. Width 560px.

**Keyboard Shortcuts**: `Command+K Command+R` and the Help menu open a read-only cheatsheet of
every live binding, user overrides included. It is something the user reads rather than aims
through, so it takes the Dialog scrim, not the picker's. Layout: title, one dense search field
(matching title, category, or shortcut), then two balanced columns of category blocks in catalog
order, each a small uppercase `meta` heading over `dense` rows with the title left and compact
keycaps right; a command with two bindings shows both. A block never splits across columns. The
footer's single ghost **Edit Keybindings** button closes the sheet and opens the Settings
Keybindings page, which stays the only place to change a binding.

**Project search**: `Command+Shift+F` opens a centered overlay 70% of the window in each direction,
not a panel inside Files. Search is a workspace-wide question and its answer wants two columns; a
310px sidebar could show a file list or a line of context, never both, and it paid for the panel by
hiding the file tree the results are about. The overlay leaves the tree on screen behind it. It is
the one surface built on the picker shell that takes the Dialog scrim rather than the picker's
transparent one: a picker stays see-through because the user is aiming at the workbench underneath
it, while this surface carries its own preview and is itself what the user is reading, so dimming
the workbench is honest about the workbench being inert. It reads as controls / results / preview:
one row of query field, the three content-mode toggles, and the Name–Content segments; then results
on the left at 42% and a snippet of the selected file on the right, four lines of context each side
of the match, read through `files.read` rather than by widening what a search result carries; every
scan would otherwise pay for context the user reads one file at a time. A name result has no line to
center on and shows the head of the file, which is what tells a reader which of nine `index.ts` they
found. Focus never leaves the field: `↑`/`↓` move the selection and hold at both ends rather than
wrapping, `Enter` opens, `Command+Enter` opens to the side, and a pointer selects with one click and
opens with two. A single click selects without opening a preview tab: the pane beside the results already is that preview, and a tab opening behind a modal is a
change the user cannot see. Opening a result dismisses the overlay, and a fresh open starts empty.

**Session switcher**: the hold-to-cycle MRU overlay (`Recently used Sessions`) is a modal moment
that ends on key release, so it wears the picker scrim above rather than the Dialog one, and the
palette's 560px width, centred. Like VS Code's editor switcher, the workbench stays fully readable
underneath while the chord is held; the scrim still swallows pointer events, and clicking it cancels
exactly as Escape does: without that, clicking a Session in the PrimarySidebar mid-chord switches
once and then the switcher commits a second, stale jump on release. It reads top to bottom as caption / list / hint: a panel-caption
title with the live position on the right, Session rows (Agent identity icon, title over Project,
relative `Last opened`, then the same right-edge status indicator the PrimarySidebar renders), and
a footer of live `kbd` chips for cycle, reverse, cancel, and
release-to-commit. The highlighted row is the one place a list selection may carry `--accent` (an
inset ring over the `--elevated` fill): the surface exists only while its chord is held and its
whole purpose is to show where the pending jump lands, which is the transient action-scoped
carve-out in principle 2. Cycling scrolls the highlight into view; a pointer may highlight a row
by moving over it and commit it by clicking.

**Agent-choice dialog**: the centered `Start a Session` dialog that follows Add Project (every
other entry point uses the Project row's anchored New Session menu) lays the Terminal catalog out
as one row of Dock-style tiles inside a 12px `--background` tray, not as full-width buttons: four
choices read faster as icons than as a stack of wide bars. Each tile is a 56px `--elevated` icon
well over the Agent name and a reserved one-line slot for the row's muted suffix (`Chat`,
`Not installed`), so labels share a baseline whether or not a suffix is present. Hovering lifts and
scales the well and washes the tile with `--state-hover`; keyboard focus draws the shared accent
border and glow on the well, not around the whole tile, and the arrow keys, `Home`, and `End` move
between tiles. An Agent that is not installed stays pickable but its well recedes. Below the tray
sit the full-access notice, then a hairline footer with the two preference Switches and the quieter
ghost `Empty Session` escape hatch.

**Agent Actions picker**: `Command+Shift+A` opens an independent 560px picker only for a running
Agent Terminal. Its fixed target line names the provider, Session, and Terminal captured at open;
results are grouped as Commands and Skills and searchable without typing the `/` or `$` prefix.
`Enter` submits an argument-free action directly; `Command+Enter` appends the exact invocation plus
one space to the existing draft without submitting it. Actions with required arguments must first
be inserted and completed in the Terminal. The footer exposes both key meanings and a quiet
`Manage in Settings…` route. Selection or `Escape` returns focus to the captured Terminal. The
picker never reads, clears, or replaces the current Terminal draft.

**Inputs**: shared `Input` density is always explicit outside standard forms: `standard` (36px,
base), `dense` (28px, dense), `compact` (24px, dense), or `palette` (44px, base). `appearance`
selects the standard themed fill, workbench canvas, inline surface, or an embedded field owned by
`InputGroup`; all variants share one border, focus ring, invalid, and disabled contract. Adorned
search/path fields use `InputGroup`, never feature-local field chrome.

**Agent Chat composer**: one radius-8 `--surface` card with a 1px `--border` that turns `--muted`
while focused (the pane ring already carries the accent focus) and `--accent` while a file is
dragged over the Chat. The whole pane takes the drop under a faint `--accent` tint with a centered
`--elevated` label (`Drop to add images, files, or folders`, or `Drop to add files or folders` when
the provider takes no images). A dropped image attaches when the provider accepts images; any other
file or folder from Finder becomes a card, while a Files entry or Editor tab dragged from inside
Caxri is inserted at the caret as its path, spelled relative to the Agent's directory the way a
Terminal drop is. Inside, top to bottom: the attachment tray, bottom-aligned with a 10px gap as in
the Codex app (112px radius-8 image thumbnails, drawn from a preview that covers the 96px
sent-message tile at 2x, and 56px-high radius-8 `--elevated` path cards whose 40px `--background`
tile holds a folder or file glyph beside the name and a `--muted` `Folder` or `File` line, the full
path in a tooltip; every item carries a 20px round remove control on its top-right corner; clicking
a thumbnail previews the full image in a dialog, and an image that takes
noticeably long to read holds a placeholder tile with a spinner, so a disabled Send has a visible
cause), a borderless auto-growing message input that renders its Markdown in place (headings at
17/15/13px semibold, bold, italics, strikethrough, inline and fenced code on a `--border` 45% tint in
the editor font, `--muted` bullets drawn as `•` with wrapped text hanging after them, quotes with a
3px `--selection` rule; syntax reappears in `--muted` where the caret touches it, like the Codex
app and Obsidian; a pasted `http(s)` URL is drawn as the sent message will draw it, in `--accent`
led by its site icon, a pull request's glyph and text tinted by its state, while its text stays
editable), and one action row in `--muted`, split like the Codex
app's composer. Leading on the left: `+` (a round ghost icon, tooltip `Add files and more`, that
turns into a spinner while picked images are read, a long paste is saved, or a Session reference is
written), a Plan chip (a bulb and `Plan` in `--foreground` on the `--selection` fill with a `--border`
outline, a pressed toggle that turns plan mode off) while plan
mode is on, and the permission picker. `+` opens a menu laid out like the Codex app's: under `Add`,
Files (the system file picker; its muted description says what a pick does for this provider,
`Attach images or insert file paths` or `Insert file paths`), Goal (only while the provider reports
a `goal` command; it enters Goal mode), and Plan mode (with its description and a
trailing check while on); under `Sessions`, the five most recently opened Sessions with an Agent
conversation, each cited at the caret the way the `@` list cites it. Folders cannot be picked yet:
Chromium's file input selects files only. Trailing on the right: the context meter (a
14px ring, as in the Codex app's composer: a faint track and an arc over it that fills with the share of
the window in use; a quiet `--muted` glyph
with no number below 85%, and from 85% `--warning` with its percentage beside it, matching the
compact alert there, because running low on context is advice, not a failure; a `meter` and a Tab
stop whose popover gives the token breakdown and, when the provider has a compact command, a Compact
button; it opens on click, Enter, or Space only, with focus inside so Tab reaches Compact, never on
hover, so a pointer passing over the bottom row never throws a card over the draft), the model picker (a pill holding a filled `--foreground` bolt while Fast mode is on, not
`--accent`, so the composer keeps one accent per screen (Principle 2), and a workflow glyph
while ultracode is on, then the model's name and the next turn's effort, which it keeps reading
while its panel is open so the pill never resizes under the pointer; a spinner replaces the chevron
until a switch is confirmed), and a
single primary action slot. The model picker opens a 288px popover copied from the Codex app's: a
header with the mode toggles on the left (Fast's bolt, ultracode's glyph; `--muted` while off,
`--foreground` on the `--selection` fill with a `--border` outline while on, the Plan chip's pressed
treatment, never `--accent`; each explained in a tooltip above it), the effort in 15px semibold `--accent`
over the model name and a chevron in the center, and `Reset to default` (a rotate glyph, disabled
while the effort is the model's default) on the right; below it, a slider with one stop per effort
(a 24px `--foreground`/15 track filled in `--accent` up to a 28px `--foreground` thumb, a 4px dot on
every other stop, and twinkling dots across the fill while Fast mode is on). Dragging previews the
effort in the title; releasing applies it and keeps the popover open. The model name opens the model
list in place: a `Choose model` caption, one row per model with a trailing check on the current one,
and each model's description in a tooltip to its right (Claude Code's `default` alias keeps its
description inline). Choosing a model returns to the effort panel when the model has efforts or
modes, and closes the popover otherwise; a model with neither opens straight on the list. The
permission picker shows a shield and the level's name with no disclosure chevron, in the same muted
tone at every level; full access differs only by its alert shield, since a trigger tinted yellow all
day is noise for someone who always runs it. For a provider that applies a switch only
from the next turn (Codex), it adds a `from next turn` caption while a turn runs. Its menu leads every level with a glyph (an eye for read only, a hand for ask, a pen for
accept edits, a bot for auto, the `--warning` shield for full access) and trails the current level
with a check; a chosen Full access row reads in `--warning`, as the Codex app tints it. Every
checkable menu row in the app trails its check, as macOS menus do. The primary action slot is a 28px `--foreground`
circle holding a `--background` up arrow for Send (an arrow-up-to-line while it would steer the running turn, a return arrow while the message would queue),
a small filled square for Stop, or, after a stopped or failed turn with nothing typed, a 12px filled
play glyph for Continue: smaller than the 16px arrows because a filled shape weighs more, and never
`--accent`, since it rests on screen until the user acts. While a turn runs, holding Cmd (or Ctrl) turns Steer into Queue before
any key is pressed: an `--accent` circle with a return glyph named `Queue message`, which a click
then queues too. That slot
shows Stop while a turn runs and the input is empty, and Send as soon as there is content; the two
never sit side by side. While Send cannot send, its tooltip says why (`Chat loading…`, `Reading
image…`, `Type a message to send`, or the recovery row to use). While a turn runs, Enter and Send steer
the message into it (Send reads `Steer message`, the placeholder `Add to this turn`); Cmd+Enter queues it for
after the turn instead. While the Chat is otherwise busy (compacting, or draining the queue) Enter and Send queue
(`Queue a follow-up`). The keys live in Send's tooltip, one row each with its keycap (`Steer` Enter, `Queue`
⌘Enter, `Stop turn` Esc), never as a hint row above the input, since a hint shown on every turn
costs a row the user learns once. Typing `/` or `$` opens the suggestion list above the card under
`Commands` and `Skills` headings. Each row leads with a 16px muted glyph naming what it is, the
same glyph that thing wears elsewhere: `SquareSlash` for a command and `Package` for a skill (the
sent message's invocation chip), a file's type icon (the Files tree), `MessageCircle` for a Session
(the `+` menu), and `History` for a sent prompt. A `meta` footer names the keys as compact `Kbd`
keycaps, like Send's tooltip, ending in `Esc to dismiss` (a list with no row to choose offers only `Esc to dismiss`, never an Enter that would send
the draft); a query with no match keeps it open on a `No matching command or skill` row. Typing `@`
opens the same kind of list of other Sessions to cite, each with its Project; a title more than one
row shares adds when that Session was last opened (`· 3h`), a query with no match reads `No Sessions
match`, and after a choice the list becomes one spinner row (`Preparing “Title”…`) until the
reference is written, while Enter waits. Both lists show only while the input has focus. Queued
messages list in the composer strip (below) as 13px rows laid out like the Codex app's queue: a
`--muted` queue glyph, the message, then its actions, always shown rather than revealed on hover: a
labeled ghost `Steer` (`Send now` with no turn running), an Edit icon (back into the composer), and a
Delete icon, which moves a text-only message back into an empty composer (so a mis-click is recoverable) and deletes it
outright when the composer holds a draft or the message carries images; Edit is not tucked into a More menu, since a menu holding one item costs a click and hides nothing. A waiting queue has no header, since its rows already read as what goes
next. While a turn runs and the input is empty, Enter steers the first queued message and the
placeholder says so; no chip on the row repeats it. A paused queue is headed by a row that
names why (`queuePauseReason`): a stopped turn reads `Queue paused` with Resume, a failed send
reads `Couldn't send queued messages` in `--danger` with Retry. The dock above the composer (recovery row and requests) is capped
at 60% of the pane and scrolls past it. Above everything in the dock, a recovery row explains why the Chat cannot
continue: a provider failure in a `--danger` bordered card with Retry (a conversation the provider
could not resume adds a body naming the cause and Open as Terminal), or a hand-over to another
client in a neutral `--border` card with the PTY recovery bar's unplugged glyph, its Detached label,
and Resume. The card is inset 12px like the composer strip so the two share edges; while either shows, Send is disabled. Running subagents and background shells, and the Agent's plan, live in the composer strip (below)
as collapsible sections rather than cards or popovers. The Background work section lists failed then running
tasks with elapsed time and their own Stop, and a header control (a history glyph with the ended count, so ended work
takes no row of its own) expands the ended tasks, most recent first, with how each ended; a shell is named by the Agent's
description of it (Claude Code's `Bash` description) when there is one, with its command line atop
its tab's output, and by the command line in monospace otherwise; clicking one, or the Open action on
its timeline row, opens it as
a read-only tab split to the right of the Chat, reusing that side pane for later tasks. A user
message steered into a running turn carries an 11px `--muted` `Steered` caption; a queued one is an
ordinary message once delivered and carries none, since `Queued` would read as pending. Escape
interrupts a running turn regardless, from the composer or anywhere else in the Chat pane that is
not an editable field or an open menu, list, or dialog. Once Stop is requested the Stop button shows
a spinner and the status row reads `Stopping…` without the sweep; a failed request
releases both and a toast says so. While the Chat starts, works, or waits on an answer, a 32px
status row sits in a strip on top of the card rather than inside it, so the Chat's state never reads
as part of the draft (reference: LobeHub's chat input). The strip is a `--surface` tab inset 12px
from the card's sides, its top corners radius-8 and its hairline resting on the card's top border;
the `Editing an earlier message` bar and the idle context notices below use the same strip. Everything
else that waits above the input joins that strip as hairline-divided sections instead of its own
card, so the stack reads as one tray (references: LobeHub's input trays, T3 Code's composer drawer):
the goal row, then the Plan and Background work sections, then queued messages, then the status row
nearest the input, since it changes most often. The Plan and Background work sections each have a 32px
header that folds and unfolds the list under it, remembered per Chat: a glyph, the label, the count
on the right (`2/5`; `1 running · 2 failed` with the failures in `--danger`), and a trailing chevron
that turns as the list opens. Folded, the Plan header also names the current step and the Background
work header shows each running kind's glyph with its count (subagents before background shells, so
one kind never hides the other), so folding never hides that work runs. With a single running task and no failure,
Background work drops its header and fold: that task's row is the whole section, with the ended-count control beside
its Stop, since `1 running` would only repeat the row. The plan list scrolls past
192px. The Plan section shows while the Chat is busy and after the turn only while the plan is
unfinished; Background work shows while anything runs or a failure from the latest turn is
unseen, and its X dismisses those failures. The status row is the one place the turn's live state
shows, except while a turn works on an active goal, when the goal row below takes its place: on the left Buddy, the turn's verb (which swaps with a short rise, blur, and fade), and the
elapsed time (`4m 23s`); on the right the turn's spend as bare icon-and-figure pairs with details in
tooltips (cost without a `$`). Rows and the strip's frame appear and leave at once, with no fade or
unfolding height: animating them pushed the transcript up and back down whenever a turn started or
ended, and with several rows trading places the composer's top edge read as jumping. Only a fold the
user makes animates; inside the status row numbers roll, and all of it honors reduced motion.
References: the Codex app's and Mux's compact turn summaries and the Codex app's collapsible plan
and background lists above the composer. While the provider pursues a goal, a goal row leads the strip, after the Codex
app's: a goal glyph (`--accent` while active), the status in `--foreground` medium only when the goal
is not active (`Goal paused`, `Goal stalled`, `Goal hit usage limits`, `Goal budget reached`, `Goal
achieved`), the objective truncated in `--muted`, the goal's time (`1h 37m 29s`, localized like a
turn's time, rolling each second only while an active goal's turn runs), the goal's spend across all
its turns as the status row's icon-and-figure pairs, and ghost icon buttons Clear, Pause or Resume,
and Expand, which shows the whole objective below the row. While a turn works on an active goal the
goal row is the Chat's live state and the status row stays out of the strip: the provider starts the
goal's turns on its own, so a second row would repeat the work with a second clock and figures that
start over each turn. The goal glyph sends out one `--accent` ring (a single `animate-ping`) for
each model request the goal makes, and the objective carries the working text's sweep; the glyph
stays between the provider's turns, so the row's lead never swaps. The composer's placeholder reads
`Add to the goal` instead of `Add to this turn`. A turn that is stopping, compacting, or waiting on
the user keeps its own status row. A completed goal stays until cleared. Claude Code's `/goal` reads
the same while it is pursued, without Pause, since Claude Code cannot pause a goal; the row leaves once
Claude Code accepts the goal as met, and its time counts only the turns that worked on it. Goal mode, entered by choosing
`/goal` from the suggestion list or Goal from `+`, adds a Goal chip after the permission picker,
divided from it by a vertical hairline, and changes the placeholder to `Describe your goal, define
measurable outcomes for best results`; Enter then sets the draft as the goal, and the chip or
Backspace in an empty input leaves the mode. A working turn's label is one playful phrase chosen per turn from Caxri's own list (`Mapping the terrain…`),
so a long turn reads as progress rather than a stall; a waiting one shows no row, since the
approval or question card right above the composer is the waiting state. On an idle Chat the strip
carries context notices instead: an expired prompt cache in `--muted` (a cost fact, not a fault),
and context high enough to read `consider compacting` in `--warning` (a suggestion, since nothing failed) with a Compact button. References: T3 Code's Chat composer, Claude
Code's spinner verbs, and the Codex app's round Send and Stop, context ring, and model and effort
picker. In the transcript, inline code sits in a lifted `--elevated` chip and links take
the full `--accent` with no underline until hover; a code block is one radius-8 `--elevated` panel whose header (a code glyph, Monaco's
language name such as `TypeScript`) shares its fill and sets its code in the 11px
`meta` size every monospace preview uses; a table is set open, with row
hairlines and no frame or header tint. A closed `mermaid` fence renders as a diagram panel in the
same frame (a diagram glyph and `Diagram` in the header). Each block keeps its actions (wrap and
copy for code, copy for a table, copy source for a diagram, then View Full Screen) out of the reading
path: they fade in on hover or keyboard focus, as a header cluster on code and diagrams and as a
small floating pill at a table's top-right corner. View Full Screen opens the block in a dialog
inset 32px from the window with the same actions in its header: code at 12px, a table at 13px, and
a diagram at its natural size inside the preview zoom frame (wheel to zoom, drag to pan). A Markdown
code block over 20 lines folds to its first 15 under a fade into `--elevated`, with a centered
`Expand (N lines)` pill; expanded, a `Collapse` pill sits below the last line, and collapsing scrolls
the block's top back into view. Copy and full screen always carry the whole code. Tool output keeps
its own height cap instead. All follow the Codex app's Dracula transcript; fullscreen follows ChatGPT
and Claude.ai's block expansion, and folding follows Linear's documents. A path the
Agent writes as plain prose (`src/app.ts:12`, an absolute path) is a file link like a cited one;
in the user's bubble a path or URL takes the same `--accent` with no underline until hover, so a
link reads the same on both sides of the transcript. A user message longer than 12 lines clamps with
Show more / Show less; clicking a sent image opens a larger preview, a loading one pulses, and one
whose data is gone says `Image no longer available`. Files and folders the message attached sit
between its images and its bubble as 28px round `--elevated` chips (glyph and name, full path in a
tooltip); clicking one opens the folder in Finder or reveals the file there. A web link leads with the site's favicon (the
GitHub mark for GitHub, a globe when there is none, fading in only on first load), underlined only
on hover; hovering it opens a 320px card naming the host with an Open action, then where the
link leads (`owner/repo · #N` beside a pull request, issue, or discussion glyph for GitHub). A user
message that starts with a skill (`$name`) or command (`/name`) shows it as an `--accent` chip;
clicking the chip opens a popover with that skill's rendered Markdown. A `/new-session` message is a card in the bubble's
place: an `--accent` `MessageSquareShare` chip reading `New Session`, then the user's note (or a
muted `Hand off the next task to a new Session`), and, once the Agent created that Session, a
hairline-separated 12px `Continued in` row whose title opens it. The new Session's first message
wears the same glyph in `--accent` with `Continued from` and the asking Session's title, so both
ends of a hand-off read as one move; an ordinary delegated task keeps the muted `Forward` glyph and
`Delegated by`.

**Agent Chat plan**: the latest plan docks above the composer as one 32px radius-8 `--surface`
row with a 1px `--border`: a list glyph, `Plan`, the step the Agent is on truncated in `--muted`,
then right-aligned a 4px segment per step (`--success` done, `--muted` in progress, `--border`
pending; omitted past ten steps), the `done/total` count (`--success` once complete), and a
chevron. It starts collapsed and expands in place to the explanation and the step list (scrolling
past 240px), keeping that choice while the plan updates. In the list a done step is a `--success`
check, the current step a spinner while the turn runs (a dotted ring once it stops), and a pending
step a dashed ring. The card is inset 12px like the composer strip so the two share edges.
Reference: T3 Code's composer task badge.
A pending approval titles the tool in the timeline's words (`Allow editing app.ts?`, `Allow
create_issue from github?`), never its raw identifier, and names its buttons by outcome: Run for a
command (Allow when it reaches a network host), Apply Changes for a file edit, Allow for any other
tool, Start Building for a plan, then `Always Allow in This Chat`, then Deny (Keep Planning for a
plan). Allow Request (Cmd+Enter) approves and Deny Request (Cmd+Backspace) denies, answering only the first card
and only while the composer is empty, where neither chord has another meaning; both are rebindable
in Keyboard Shortcuts, and the buttons' tooltips show the bound keys. A question names the provider (`Codex has a
question`), and each option's description sits under its label in `meta` `--muted`, not in a
tooltip. While the reader follows the end, the transcript stays pinned when a dock grows and
shrinks the view. As in ChatGPT and the Codex app, the latest user message rests 112px below the
top of the view at the end, leaving the last lines of the previous reply in view as context: the transcript keeps empty space below the latest turn, so a sent
message rises to the top and its reply fills in below it; once the turn outgrows the view the space
is gone and following the end takes over. As in the Codex app, a turn ending never moves the view:
the finished turn keeps its place and the space below it, and scrolling back through history
consumes the space by as much as the view moved, without it ever growing back. A Chat opened idle
rests on the view's bottom rather than leaving a blank view to scroll through.

**Agent Chat timeline**: work is secondary to the conversation. Every command, tool call, file
change, and thought is one 12px `--muted` disclosure row: the tool kind's glyph (the Codex app's
set: an open book for reads, four linked nodes for MCP), a past-tense verb that names a non-success outcome in words (`Failed to
edit`, `Not allowed to run`, `Stopped editing`), the subject in the body font (a single file it read
or changed is an underlined link that opens it), and trailing facts
(a `+N -M` diff stat, a non-success status glyph, a duration of at least one second; a command
always shows its duration, plus a `--danger` `Exit N` when non-zero and a `--surface` `Background`
tag once handed off). A command the Agent described is titled by the description in the body font,
and its command line moves into the expanded view. An MCP call leads with its server's own 14px
icon (radius 2, fading in over the generic MCP glyph that holds the slot while it loads, which stays
when the server has none) and reads as the tool alone in sentence case (`Web search exa`), since the
icon already names the server; expanded, its arguments list as muted mono names beside body-font
values, and its result wraps. Back-to-back thoughts are one row titled by the latest summary title;
expanded, its text is the row's 12px `--muted`, bold titles included. Consecutive work collapses into one summary row. While it runs, the
row names the newest active action and its target ("Reading app.ts", "Running git status --short")
and uses that tool kind's glyph. While it is still the running turn's latest work, its title keeps
sweeping and naming the newest step between calls (`Running git status --short` after that command
finished), so a run of fast commands never reads as idle. Calls running at the same time add a count
to the title (`Listing src and 2 more`) and lead with the generic work glyph when they mix kinds. Its chevron follows the title and stays
shown while expanded, and the expanded rows continue at the header's own pitch. Once the run ends
(a reply follows it or the turn ends), it becomes an aggregate (`Ran 3 commands, read 2 files`) that leads with the glyph of the one kind its
items share (an MCP lead shows that call's server icon), or the generic work glyph when they mix
kinds, ending `, N failed` when items
failed or were declined, whose expanded list scrolls past 240px and fades its clipped edge over
24px. A shell command that only reads, searches, or lists files reads as that action (`sed -n
'1,40p' src/app.ts` is `Read app.ts`, `rg foo src` is `Searched foo in src`), keeping its command
line in the expanded view. Explorations chained with `&&` read as one (`Read a.ts, b.ts`), a search
over `rg --files` reads `Found files`, and a read of a skill's `SKILL.md` reads `Used skill
review` with the skill glyph. A test run (`Ran tests a.test.ts`, flask glyph), a commit
(`Committed` with its message, or `Committed and pushed`), a push (`Pushed feat/x`), and a `gh pr`
step (`Opened PR`, `Merged PR #12`, `Checked PR`) name the step the same way, through wrappers
such as `rtk`, `bunx`, `cd dir &&`, environment assignments, and `2>&1`; while running they keep
the command's live glyph. A finished turn folds everything except the prompt, the final reply, and
notices behind one `Worked for 2m 1s` row with a bottom hairline. Expanded, the row pins to the
top of the transcript on `--background` until the fold's last row scrolls past (LibreChat's activity
groups), so a run several screens long folds from wherever the reader stopped, and folding holds
the row where it was clicked; a failed or stopped turn's row
(`Failed after 40s`, `Stopped after 3s`) takes `--danger` or `--warning` with its glyph. A turn
the user stopped names it (`Stopped by you after 1m 7s`) and keeps the stop glyph in `--muted`,
since nothing went wrong; a stop another Agent sent reads `Stopped by an Agent`. A stopped turn
with no work to fold keeps the same row before its reply as plain text with no chevron, so a cut-off
answer never reads as one that simply ended. A provider retrying a failed request shows a
`--warning` row led by its cause's icon (`WifiOff` for a lost connection, `Hourglass` for a rate
limit, `ServerCrash` for an overloaded or failing server, `RotateCw` otherwise) and the attempt
against the limit, `Connection lost, retrying (2/10)`, with the provider's detail in `--muted` under
it; a muted line read as routine progress while the Agent sat stalled. A running
row carries no trailing spinner: its shimmer and ticking time already say it runs. While a running
turn has shown nothing after the prompt, a small figure holds the place where the reply will start
(`agentChat.workingIndicator`: Buddy, a round face that glances around and blows thought bubbles,
by default; or three 6px `--muted` dots breathing in turn, a caret, a braille spinner, or an orbit;
all still under reduced motion), hidden from assistive technology since the composer's status line
already announces the turn. The most recent
turn's final reply, like every earlier one, shows Copy only on hover or keyboard focus, in a row
that keeps its height. Replies add no Tab stops: `Option+ArrowUp`/`Option+ArrowDown` in the
transcript focus the latest or the adjacent reply, revealing its row, and Tab reaches Copy. Between the final
reply and Copy, a finished turn shows what it left behind as `--surface` cards with a 36px
`--background` glyph tile: `Edited 3 files` over the turn's `+N -M` (hovered, the counts become
`View changes` or `Hide changes` and preview the diffs; with its always-visible chevron it is the
card's single expand toggle, and it carries no external arrow because nothing leaves the Chat), a
ghost Undo, and a labeled secondary Review (the one action that opens something else: the whole
turn as one commentable diff in a side tab), then one row per file with its directory in `--muted`
and its name in `--foreground`, each disclosing its own diff. Past three files the rest fold behind a
`Show N more files` row (the Codex app's fold, so a large turn does not push the next reply off
screen) that becomes `Show fewer files` once unfolded; unlike the sidebar's reveal row it carries a
chevron, because it collapses again. Folding closes the hidden rows' diffs, and disclosing every
diff from the header unfolds the list first. Then one card per pull request or
issue the turn created or edited, with the GitHub or Linear mark, the title, a monospace
`owner/repo#N` or `ENG-12`, the body's first line, and `Created pull request` with a trailing
external arrow at the end, since that card opens the browser. An issue's card adds a ghost icon
button after the card's own click area, outside it, with the hand-off glyph (`MessageSquareShare`)
and the tooltip `Start ENG-12 in a new Session`; a pull request or acceptance card has none. A screen
reader hears `Reply ready`, `Turn failed`, or `Stopped` when a turn ends. A Chat that keeps only the
recent part of a long conversation opens with a `meta` line saying so, since the provider still has
all of it, and Open as Terminal. `Jump to latest` is a 32px round down-arrow button with no caption
(its name lives in the accessible label and a hover tooltip; reference: the Codex app), and it shows
only once the end of the latest entry has
left the view, not while the reader scrolls within the empty space kept below a short latest turn,
where it would have nothing to bring back. It
returns focus to the composer (to the scroll view in a read-only task tab). Expanded output renders
in the shared code view at the `meta` size diffs, the command preview, and task output use, painted in the language inferred from what produced it (a printed file's
extension, a Git diff, JSON), any other command output as shell, and capped in height. A new
tool kind gets its glyph in one table, not a new component. References: the Codex app and T3 Code's
work log. Releasing a text selection in a transcript (a Chat or a subagent tab) floats a popover-styled
`--elevated` toolbar 8px above the selection's first line, below its last line when there is no
room, holding `Copy` and `Add to message`. Copy confirms in place with a check, never a toast; Add
to message appends the selection as a `>` Markdown quote paragraph to the Chat's draft and puts
the caret on a new line after it; from a subagent tab it brings the parent Chat forward. The toolbar follows the selection as the transcript scrolls and leaves on
Escape, an outside press, or a collapsed selection. References: Synara, LibreChat, assistant-ui.
Code selected in an editor floats the same toolbar, holding one action named after where the
reference goes: `Add to Chat` when the Session's most recently opened Agent is a Chat, `Send to
Terminal` otherwise, with the command's shortcut (`⌥⌘K`) beside it. It sends `@path#L3-L9` the way
the shortcut does: a Chat gets it at the end of its draft and comes forward with the caret after it.
The editor toolbar shows only while the editor has focus. References: Cursor, VS Code Copilot.

**Settings**: a Workbench tab, not a modal: `Cmd+,`, the menu, and the palette all open or focus
this one tab instead of raising a dialog, so it composes with every other document (the Archived
Sessions manager still floats its own confirmation dialog over it, exactly as it would over any
other tab). Its description reads: "Changes apply immediately and are stored as editable files."
It has exactly one navigation: a left column listing the `settings.jsonc` categories and their
subcategories, then Keybindings and Theme after a separator. No horizontal section strip sits above
it: the Workbench tab bar is already the page's only tab row. The column stays mounted and in place
for every section and for the Source view; picking a category from Keybindings, Theme, or Source
returns to the Settings list scrolled to it. The current category takes `aria-current="location"`,
the current file section `aria-current="page"`.
Field labels in plain language; byte values rendered as human units (`2 MB`) with unit-aware
input. There is no Apply button and no per-section dirty marker: a structured control writes as
soon as it changes, and the raw source editor commits when it loses focus, reporting a parse
failure in place instead of persisting it. A keybinding that collides with an existing chord is
still written and flagged inline on both rows: the editor reports conflicts, it never blocks the
user out of one. Compact scalar controls (select, number) share one width and keep labels left with
their unit inside the field; a plain-text or explanatory row spans the full row width under its
label instead. Settings and form rows compose the shared Field primitive (label left, description
under the label, control right); instant boolean preferences render Switch at the row's trailing
end (including each entry's toggle inside the Claude Code command list) and clicking either the
label or the control toggles it. Keybindings group under their catalog category instead of one flat
list, keep each row's command id out of sight behind a hover tooltip, and drop the shared `Kbd`
chip's own border where the row's own control already supplies the chrome. Theme colors tile in a
grid instead of one tall column per section, and Import Theme lives on the preset row rather than
its own toolbar above it. Provider launch groups use quiet `--elevated` sections headed by the
shared Agent identity icon, and every multiline value uses the same themed field/focus redline as
single-line input.

A consequential choice may not live only inside a free-text field. Every bundled Agent launches
without per-action approval by default, and until that was only a CLI token inside
`Initial arguments`, the setting was unreadable to anyone who did not already know the flag,
principle 3 applied to the one row where it matters most. Each provider now carries a named Switch
directly above `Initial arguments`, stating in plain words what the two answers mean and that the
change reaches Terminals started from now on. The Switch is derived over the same argument list the
user can hand-edit rather than a second stored preference, so a raw edit and the Switch can never
disagree, and it moves only the approval tokens; a confinement argument such as Grok Build's
`--sandbox workspace` decides where the Agent may work, not whether it asks first, and survives
untouched in both directions. Initial arguments are command-line argv: a flag and its value may
share a line. Where a plain-language control and a raw field describe the same
state, the raw field stays authoritative and the control reads from it.

**Toasts**: four variants (`info`/`success`/`warning`/`error`) with a 3px left bar in the status
color and matching icon; `info` uses `--muted` for its bar (an accent bar would be a second accent),
`warning` uses `--warning`, `error` uses `--danger`. The last two are not degrees of the same thing
and are not interchangeable: `warning` says the feature still works but on reduced terms and needs
no immediate answer; `error` says the thing the user asked for did not happen. A degradation the
user can keep working through is never an `error` (that would be a lie while the feature still
runs) and never an `info` either, because neutral phrasing hides that the reduced terms are still
in force. Do not add a fifth variant. Sonner owns the queue, timers, keyboard access, and swipe
dismissal. Every variant auto-dismisses after 4s of visible, non-interacting time; only explicit
`persist` notices stay until dismissed, including when their own action button is pressed, because
such an action routinely opens a confirmation the user can still cancel and deleting the card first
would take the only way back to the offer. Stack
bottom-right above the status bar, with three visible cards. Hover or keyboard focus pauses expiry.
Use the close or action button to dismiss; clicking the message body does not dismiss it. Both
are borderless compact chrome: the action sits on a quiet `--state-hover-ink-quiet` wash that
deepens to `--state-hover-ink` on hover, and the close button is a bare `X` that gains the same
wash on hover, never an outlined circle. An
extension inline action may declare its own success and failure toasts, which carry an `Open on
GitHub` action when they report on GitHub; the merge-method success toast is one. Sonner's
internal transition/removal timing is a third-party exception to the motion token layers above;
its built-in reduced-motion media rule disables animation. Theme overrides live in `styles/styles.css`.
Notifications are the one floating surface that deliberately outranks a modal: the toaster stacks
above a dialog popup instead of under its backdrop, because a failure raised inside a modal (the
Archived Sessions manager, a confirmation, an import prompt) is reported through this channel and
nowhere else, so sinking it there would turn each of those failures into silence. The dialog still
owns Escape, the backdrop, and the pointer. What the exception does not buy is operability: the
dialog's focus trap keeps the toast's own buttons out of Tab order, so a failure the dialog can
report in place belongs in the dialog, not in a toast. Settings is not one of these: as a Workbench
tab it owns no backdrop and traps no focus, so a failure raised there (a rejected settings write, an
argv restart notice) already reaches the user through this same toast channel with nothing to
compete with.

**Notifications**: the status bar bell opens a 384px-wide, viewport-constrained popover with
recent messages, Project context, occurrence counts, removal, clear-all, and a Settings shortcut.
History holds at most 100 entries in this window's memory and never stores action callbacks;
reloading the window clears it. An entry whose popup offered a recovery (`Retry`, `Undo`,
`Open Settings`) keeps offering it here, because four seconds is not how long a failure stays worth
answering. The button is rebuilt from a recorded name plus plain data, so acting on it is the same
command the popup would have run. Whether it still applies is asked at the click, never at render:
a follow-up that no longer has a target replaces itself with one plain sentence saying so, which is
the honest answer for a control that has been sitting in a list while the app moved on. Opening the center marks its entries read. Ordinary success
feedback such as copying a path stays ephemeral. Native Agent and delivery alerts enter the
same history without a second popup. Reminder popups offer an options button to stop showing
that event type across all Projects; muted events remain in history without an unread count.
Settings → Notifications restores those preferences and groups the existing native notification
controls. Failures and persistent data-loss notices cannot be muted. Worktree fallback is an
ordinary four-second reminder now that its record remains available in the center.

**Waiting popup**: a Chat that is not on screen and waits on a question or an approval asks through
one card top-center below the title bar, `min(640px, 92vw)` wide on `--elevated` with the overlay
shadow, entering on `--motion-overlay-enter` with the enter curve and leaving on
`--motion-overlay-exit`. It is not a toast: it never expires, because the Agent stays blocked until
someone answers. It shows one request at a time (oldest first) and a muted "N more pending" line,
and folds into an "N pending" status-bar item (default foreground, like the peer-approval chip) that
unfolds it on click, and again on its own only when a new request arrives, so folding means "not
now" rather than "mute"; the folded popup never floats over the Terminal or editor. It sits under
dialogs (`z-40`) and never takes focus, so it cannot steal keystrokes from the composer the user is
typing in; its keys work once focus is in it, and Focus Waiting Request (Cmd+Alt+W) moves focus there,
returning it to where the user was once the last request is answered. Allow Request and Deny Request
also answer its approval from anywhere, but only while focus rests on nothing that uses the chord
(the document, a transcript): a text field, the composer, a Terminal or editor, a button, or a
Session or Files row keeps its own Cmd+Enter and Cmd+Backspace. A held key answers once.
For about 450ms after a card drops in, a click on a question's option only selects it and an
approval's buttons ignore the pointer, because a stray click on a card that just dropped in must not
send an answer; after that, a click answers in one step, as in the Chat's own card. Esc folds the popup on both card types; Skip stays an explicit button.

**Software update**: a release Caxri finds on its own raises a notification and nothing more. A
modal belongs to a user who asked; Caxri is opened while someone is already doing something else,
and taking the screen and the Escape key for news that can wait is the nag this rule exists to
prevent. The notification carries a `Show Update` action, which outlives it in the history, and the
status-bar chip is what keeps the release reachable without opening either.

The dialog offers two dismissals, side by side, because they are different answers rather than two
strengths of one. `Close` means "not now": this app process stops offering the release, and the next
launch offers it again. `Skip this version` is recorded in `updates.skippedVersion` and outlives the
process, silencing the offer only until something newer appears, and it has a row in Settings, so
the one durable consequence of the decision is visible where it can be taken back. A reflexive
Escape must never be read as the second one.

A workbench change the user did not perform announces itself. An Agent that moves a Session into a
linked worktree re-roots Files, Source Control, Project Status, and the Editor, so it raises the
same ordinary four-second reminder as fallback, naming the destination and carrying an inline
`Undo` back to the previous root, because the only other cue is a folder name changing in the
status bar. A switch the user performed themselves stays silent; the wire reason (`followed`)
carries that distinction, since the picker and an Agent otherwise reach the same commit path.

Some notices are held until dismissed rather than expiring. A graphics failure and the moment
repeated failures pin the whole window to software rendering are both `warning` notices held until
dismissed: each reports a condition that is still true after four seconds, and one the user should
decide about now rather than find later in the history. The
two carry different routes because they leave the user with different decisions. While hardware
acceleration is still on, the crash notice offers `Turn off hardware acceleration…`: the ellipsis
is the standard promise that a question comes first, and the click itself changes nothing. Once the
window is already pinned, repeating that offer would sell relief the user already has, so the
escalated notice offers `Open Settings` instead: what is left to decide there is the durable
preference. Turning hardware acceleration off is the one click in the product that changes how
every future launch draws, so it passes the shared confirmation modal first, and that modal has to
say all three consequences: it restarts now, it lasts past this session, Settings takes it back.

A boot-flag write that only the next launch picks up is held for the same reason: closing or
switching away from the Settings tab must not make the notice disappear before the user acts on it,
and it carries the only statement of what the restart is owed for. That one is a status rather than
an event, so it names every flag still differing from the running instance's launch values, and it
is retracted once none remain.

The one-time notice that the Claude 5-hour window keeper is on by default for a Pro account is an
`info` notice held for the same reason: it discloses something Caxri does on the user's behalf
until they decide, and four seconds is too short to read and answer it. It offers `Turn off`, which
leaves with the notice once it runs, and `Open Settings` for the schedule.

**Confirmations**: destructive commands (Delete Session, Delete Project) require a native confirm
dialog naming the target ("Delete session 'api-fix'? Files on disk are not touched."). Every other
"are you sure" moment uses the one in-app confirmation modal behind
`caxri.window.showConfirm({ title, message, confirmLabel, cancelLabel })`; a feature never mounts
its own. The title asks the question, the message names the consequence, the buttons name the
outcome ("Turn On", not "Yes"), the confirming button takes initial focus, and Escape, the close
button, and an outside click all mean Cancel. It carries no danger styling on purpose: anything
destructive enough to want it belongs in the native dialog above.

A modal owns the screen for as long as it is up, so anything else standing on top of the workbench
hides while one is open. A floating surface left rendered under the backdrop is not merely
unreachable: its buttons still look pressable, and the click lands on the backdrop instead, which
reads as an outside press and answers the dialog the user was not looking at. Focus has the
matching rule: never name a disabled element as a dialog's initial focus. Base UI focuses exactly
what the resolver returns and does not fall back, so focus stays outside the dialog entirely and
keystrokes reach whatever is behind it. Name the element only once it can accept focus, and let the
popup itself hold focus until then.

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
- Revealing a chrome surface with a keybinding moves focus into it, and hiding it hands focus back to
  wherever the reveal took it from. `Command+J` and `Command+]` carry the editable-target opt-in, so
  they fire while a Terminal owns the keyboard; a toggle that changed only visibility would leave the
  revealed surface unreachable (xterm swallows Tab) and, on the way back, drop the focused element so
  the next Tab restarts from the top of the document. Hiding a surface while focus sits somewhere
  else entirely is the one case that must not move focus: the user asked for screen space, not to
  leave the Terminal they are typing in. Each surface names exactly one keyboard entry point (a
  chrome tab bar's selected tab, a tree's roving row), and every command that focuses that surface
  uses that same one.
- `Command+0` moves focus into the PrimarySidebar tree, revealing the side bar first when it is
  hidden. Double-clicking a Session row opens its inline rename editor; `Enter` does the same while
  that row holds focus, and `F2` renames the selected Session from anywhere. The shortcuts exist
  because showing the side bar has never moved focus into it, so neither the context menu nor the
  command palette could otherwise advertise a chord that worked from anywhere.
- Right-click menus are native OS menus. A surface attaches one with `useContextMenu` or
  `ContextMenuTrigger` and a builder that returns plain entries when the menu opens; Main shows it
  through `contextMenu.show` and hands back only the chosen entry, once the menu has closed, so an
  action that opens an inline input (Rename, New File) keeps focus there. Entries carry a `shortcut`
  hint from the live keybinding table (`readCommandShortcut`) instead of a literal, and a chord
  sequence renders inside the label because a native accelerator cannot express one. A native menu
  has no tooltip, so a disabled entry that is not self-explanatory carries a short `disabledReason`
  sentence ("Nothing to paste"): macOS 14.4 and later show it as a smaller second line under the
  label, and earlier releases append it after an em dash. Keep the label itself the plain command
  name. Main shows a reason shared by adjacent disabled entries (the four Split directions) once, on
  the first, so a builder still gives each of them the reason. Menus opened by a button stay Base UI
  `Menu` overlays.
- Interface zoom is `window.zoomLevel` (20% per step, the same scale as VS Code), changed from
  View › Zoom In (`Command+=`), Zoom Out (`Command+-`), and Reset Zoom. Main applies it as page
  zoom and re-centers the native traffic lights in the zoomed header; any title-bar clearance
  reserved for the lights uses `--traffic-light-clearance` or `--traffic-light-header-inset`, which
  divide by the zoom factor because the lights themselves never scale. Every zoom change except the
  first settings load shows a small HUD (the ChatGPT desktop app's pattern) at the window's bottom
  right, just above the status bar where the zoom indicator lives, so it never covers a sidebar
  title or action icon: the percentage, Zoom Out, Zoom In, a divider, and Reset, each disabled at its bound. It
  fades out 1.5s after the last change; hovering it or holding keyboard focus inside keeps it up,
  and a hidden HUD is `inert` so it never takes a click or a Tab stop. While the zoom is not 100%, a
  zoom indicator keeps saying so (Chrome's address-bar magnifier, VS Code's status bar entry): a
  magnifier and the percentage in the Workbench status bar and Caxri Bot's title bar.
  Clicking it opens the same row in a popover, and the HUD stays hidden while that popover is open;
  the indicator leaves once the zoom is back to 100% and the popover closes.
- Launch shows the Caxri mark over the translucent (vibrancy) window from the first frame: the
  loader is inline in `renderer/index.html`, so it needs no bundle, and `App` removes it when the
  workbench attaches. Only a startup failure adds text beneath the mark.
- On macOS the primary sidebar is frosted glass by default (LobeHub's pattern): the window's vibrancy
  material shows through a 62% tint of `--surface`, while the main column keeps the opaque
  `--background` so content never sits on a moving backdrop. It applies only when the theme's
  lightness matches the system appearance, because the native material follows the system, and
  never in full screen, where nothing sits behind the window and the material reads as a flat grey
  sheet; `primarySidebar.translucent` turns it off. While the Setting is on but the sidebar stays
  opaque, its Settings row says why in a muted line. An inactive window renders the material flat grey;
  that is native behavior.

## Performance Monitor

- The overlay is a 256px elevated card (`bg-elevated`, `border-border`) on `z-[100]` inside a
  `pointer-events-none` layer, so only the card takes input. Its 24px header is the drag handle;
  dragging writes `transform` directly and commits once on release, and the card is clamped into
  the viewport on resize and when its content grows.
- Numbers use `font-mono tabular-nums`; the fps value is 15px, all else 11px. Tone uses only
  `text-success`, `text-warning`, `text-danger`, `text-muted`. Bars in the frame graph share those tones.
- The detached window uses the 36px hidden-inset title bar of Process Explorer, with the same
  Overlay | Window toggle in its footer.

## Known gaps

Acknowledged debt in the current spec. Entries here describe shipped reality, not an endorsement;
resolving one requires updating the sections above in the same change.

- **Panel toggle shortcuts**: `Command+[` / `Command+]` collide with editor indent/navigate muscle
  memory. They do fire from Monaco and xterm (all three chrome toggles take the editable-target
  opt-in, which is what makes the focus handoff above necessary), so what remains open is the
  collision itself: rebinding, e.g. `Command+B` for the PrimarySidebar, is a product decision nobody
  has made.
- **Tree rows that are not treeitems**: three known violations of the Trees rule above survive
  because removing them would cost a user-visible affordance: the extension tree's error row keeps a
  focusable `Retry` button inside `role="tree"` (dropping it would make recovery unreachable), the
  process `treegrid`'s column-header sort buttons and column resize separators are extra Tab stops
  beside its single row stop, and the PrimarySidebar still has two generic wrappers standing between
  `role="tree"` and its rows. Fixing any of them needs a real interaction design, not a role swap.
- **Bug Report annotation ink**: `screenshot-annotations.ts` hard-codes `#f43f5e` and `#ffffff`
  instead of theme tokens. The same color has to appear in the live SVG overlay and in the
  rasterized JPEG the Agent opens, and no token can repaint bytes already written to a file.
