# Render layer — per-scenario render counts

The render layer answers one question the code and screenshot layers structurally cannot: **how much
React work does this interaction actually cost?** A screenshot cannot show that one click
re-rendered seven hundred component instances, and reading a component cannot tell you how often it
ran.

It measures counts, never durations. `docs/renderer-performance.md` forbids ranking components by
subtree-inclusive Fiber duration, because a parent always "costs" more than its children under that
metric. Mounts and updates per instance carry the finding; `windowMs` in the header is the sample
window (including the quiet period that ended it), not an interaction duration.

The collector is `../scripts/render-count.ts`. It talks to a running unpackaged instance over CDP.

## 1. Launch an instrumented instance

react-scan must be armed **before** react-dom evaluates, so the DevTools hook exists when React
registers its renderer. `CAXRI_REACT_SCAN=1` makes `electron.vite.config.ts` fill the
`virtual:caxri-react-scan-boot` module, which `apps/desktop/src/renderer/src/main.tsx` imports as
its very first line. Injecting react-scan over CDP after load measures nothing.

```bash
CAXRI_REACT_SCAN=1 CAXRI_DEV_CDP_PORT=9233 CAXRI_E2E=1 \
  CAXRI_TEST_ROOT_PATH="$PWD" \
  bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev
```

- `CAXRI_DEV_CDP_PORT=9233` keeps this instance off the default dev port `9223`, so a sibling
  session's window and `/Applications/Caxri.app` on `9224` are never the target.
- `CAXRI_E2E=1` plus `CAXRI_TEST_ROOT_PATH` turns the folder picker into a deterministic seam
  (`apps/desktop/src/main/test-root.ts`), so seeding a Project needs no native dialog.
- A packaged build cannot serve this layer: its Renderer is minified, so every component name
  becomes noise. Unpackaged only.

## 2. Seed a representative fixture

An empty Workbench renders almost nothing, so its counts prove nothing. Give it at least one Project
and several Sessions before sampling. Over CDP: press `Meta+O` (modifier bit `4`), click the
`Shell` choice in the dialog, then add Sessions through the typed IPC surface — `project.create`
alone returns `PATH_DENIED` because a Project root may only arrive through the picker seam.

```js
const bootstrap = await caxri.request('app.bootstrap');
const project = bootstrap.result.projects[0];
await caxri.request('session.create', { defaultAgent: null, projectId: project.id });
```

Repeat that last call once per additional Session; the worked example below used five.

Record the fixture shape (Projects, Sessions, visible tree rows) in the report: counts are only
comparable against the same shape. The worked example below used 1 Project, 5 Sessions, and 49
visible file-tree rows.

## 3. Sample a scenario

```bash
# First paint: reloads the window with the collector armed before any page script.
bun run .agents/skills/audit-ux/scripts/render-count.ts boot \
  --port 9233 --label workbench-first-paint --seconds 45 --limit 12

# One interaction: arms on the loaded window, clicks once, waits for the storm to end.
bun run .agents/skills/audit-ux/scripts/render-count.ts sample \
  --port 9233 --label session-switch --limit 10 \
  --click '.session-card[data-session-id="<a NON-active session id>"]'
```

A sample ends when no render has arrived for `--settle-ms` (default 1500), or when `--seconds` runs
out. This matters: a Session switch reaches the Renderer only after a Server round trip, and a
fixed short window once reported **zero renders** for a switch whose work simply had not arrived
yet. `settled=no` in the header means the window closed while renders were still coming — raise
`--seconds` before reading those counts as complete. `--json FILE` keeps every instance; the table
is truncated by `--limit`.

`--within COMPONENT` scopes the table and the header to one surface, such as `PrimarySidebar`: an
instance counts when it is that component or renders beneath it in the Fiber tree, so portaled
content such as a row's hover card stays with its row. The header keeps the whole-window totals in
parentheses. Scope every sample whose question is about one surface; a window total mixes in the
pane subtree a switch legitimately mounts and hides a sidebar change inside it.

The `boot` command additionally refuses to settle until `.workbench` exists, because startup has
quiet gaps while it waits on the Server and settling inside one would describe the loading shell.

### The scenario clip

Always sample the first paint, then the switches and refreshes the audit scope actually touches.
Verified selectors in the current Renderer:

| Scenario              | Selector                                                                          |
| --------------------- | --------------------------------------------------------------------------------- |
| Session switch        | `.session-card[data-session-id="<id>"]`, one **without** `active`                 |
| Secondary-sidebar tab | `[id="secondary-sidebar-tab-caxri.git"]` (also `.files`, `.project-status`)       |
| File-tree expansion   | `.file-list [role=treeitem][aria-expanded=false]`                                 |
| Refresh click         | `button[aria-label="Refresh Git"]`, `button[aria-label="Refresh Project Status"]` |

Enumerate the live targets before sampling instead of assuming state:

```js
JSON.stringify({
  sessions: [...document.querySelectorAll('.session-card')].map((node) => ({
    active: node.classList.contains('active'),
    id: node.dataset.sessionId,
  })),
  tabs: [...document.querySelectorAll('[id^="secondary-sidebar-tab-"]')].map((node) => ({
    id: node.id,
    selected: node.getAttribute('aria-selected'),
  })),
});
```

## 4. Read the table

```text
scenario=session-switch windowMs=1766 settled=yes instances=719 commits=803 mounts=46 updates=757 hidden=3
mounts  updates  firstMs  lastMs  hidden  instance
0       4        35       129     no      CatalogIcon#346
```

- **Rows are instances, not components.** `Name#id` is one Fiber (both alternates share the id).
  Aggregating by name inflates counts, can make a child look busier than its parent, and hides the
  most valuable boot finding of all: the same component mounted twice.
- **`mounts` vs `updates`.** Updates are wasted work when nothing that instance shows changed.
  Mounts in a scenario that should not create anything mean a remount — a `key=` change or a new
  element identity above it — and no memoization fixes that.
- **`hidden`** marks an instance whose DOM node has zero size or is detached. Work the user pays for
  and cannot see; the screenshot layer is blind to it by construction.
- **`repeated components (name×instances@firstMs)`** separates the two meanings of a repeated name
  by the first-render window of its instances. `FileTreeItem×49@224-229` is one list rendering
  together. `ControlledViewProvider×2@90-2400` is a subtree that was torn down and rebuilt seconds
  later.
- A count is not a finding. State the expectation first ("one Session switch should re-render the
  two affected Session cards and the tab strip"), then the observed number.

### Known-intended patterns — do not report these

- A Panel or secondary-sidebar container **stays mounted after its first show**
  (`apps/desktop/src/renderer/src/features/view-containers/view-container-surface.tsx`, the "stays
  mounted (hidden) once it has been shown" comment). So the
  first switch to a view is mostly mounts and every later switch is updates only. A hidden container
  that keeps _re-rendering_ on unrelated updates is still a finding.
- `RendererPerformanceProfiler`, `FloatingTree`, `MenuPortal`, `TooltipPortal` and friends are
  wrapper instances from the primitives; they scale with the number of rows, not with a defect.
- **`FloatingTree` and `MenuRoot` each take exactly one update right after mounting.** Base UI
  registers a freshly mounted menu into its floating tree, which sets state one level up. The
  signature is a 1:1 instance-to-update ratio at a `lastMs` just past the mount phase — at one
  measured boot, 57 `FloatingTree` plus 56 `MenuRoot` accounted for 113 of 217 post-mount updates.
  It is per menu instance, not per defect, so the way to lower it is to create fewer menus
  (issue #1107), never to chase the update itself.
- A first paint renders **twice**: once against the loading shell and again when `app.bootstrap`
  resolves. Tooltips, Session rows, the Status bar and the Files view each taking ~2 updates inside
  the boot window is that second pass, not redundant work.

## 5. Traps

- **Zero counts with `armed:true`.** The boot module calls `scan({ enabled: false })`, and react-scan
  persists that into `localStorage['react-scan-options']`, then merges the stored options back over
  the ones `start()` receives. The collector removes that key before arming; if you write your own
  probe and skip it, every count silently comes back zero.
- **Zero counts after a click.** Usually the target was already in its destination state —
  `session-row-trigger.tsx` only selects when `!selected`, so clicking the active card is a no-op.
  The script fails with "the interaction never reached React" rather than reporting the scenario as
  free. Check the enumeration above and pick another target.
- **Stale collector.** react-scan installs one instrumentation per document, so a collector from an
  earlier build of this script cannot be swapped in place. `sample` then fails with
  `STALE_COLLECTOR`; run `boot` once to reload the window.
- **The first sample after arming is all mounts.** react-scan reports every Fiber it has not seen
  yet as a mount, so the first `sample` in a window reads like a full remount (hundreds of mounts,
  zero updates) whatever the interaction did. Take one throwaway sample first and compare only the
  ones after it.
- **Repeated `sample` runs share the window.** Arming resets the counters, so consecutive samples
  are independent — but the app state is not. A scenario that changed the active Session changed the
  starting point of the next sample.
- **Stopping the instance.** Never `pkill -f Electron`. The surviving process whose `ps` command is
  literally `Caxri Dev` is the one that keeps the port open; follow the `debug` skill's procedure and
  confirm the CDP port is silent afterwards.

## 6. Worked example — real numbers from one session

1 Project, 5 Sessions, 49 visible file-tree rows, unpackaged dev instance on port 9233.

| Scenario                                    | instances | commits | mounts | updates | hidden |
| ------------------------------------------- | --------- | ------- | ------ | ------- | ------ |
| `workbench-first-paint` (warm reload)       | 1014      | 1338    | 1015   | 323     | 9      |
| `session-switch`                            | 719       | 803     | 46     | 757     | 3      |
| Secondary sidebar to Git, first show        | 262       | 513     | 236    | 277     | 35     |
| Secondary sidebar to Git, already mounted   | 39        | 65      | 0      | 65      | 14     |
| Secondary sidebar to Files, already mounted | 29        | 30      | 0      | 30      | 5      |
| `file-tree-expand` (one folder)             | 112       | 129     | 53     | 76      | 0      |
| `project-status-refresh-click`              | 9         | 18      | 0      | 18      | 0      |

How to read that set:

- The two warm tab switches (29–39 instances) are the healthy baseline for "change which view is
  visible", and the Refresh click (9 instances, 0 mounts) is the healthy baseline for "re-fetch this
  view's data". Both are strengths worth recording.
- Against those baselines, **one Session switch touching 719 instances is the finding** — it
  re-rendered all 49 `FileTreeItem` rows, 110 `ContextMenuTrigger` instances, and 3 hidden
  `ChromeTabPanel`s, none of which depend on which Session is selected.
- Expanding one folder rendered 53 `FileTreeItem` instances, i.e. the 49 rows already on screen
  re-rendered alongside the new children.
- The first show of the Git view is 236 mounts by design (§4), so it is an observation, not a
  finding.

### What that investigation found (issues #784, #785)

Both file-tree findings above had one cause: the Session scope reached each row as a prop, so every
switch replaced all 49 rows' props even when the booleans a row draws from were identical in the new
scope. Three things carried that identity down — the `scopeId`/`sessionId` props themselves, the
`requestFocus`/`setEditing` callbacks that captured `scopeId`, and the controlled-view context value,
which was rebuilt whenever the selected Session changed because both view clients captured the
Session id. Moving the scope into `resource-explorer-scope-store` and resolving the Session per
request fixed all three at once:

| Scenario           | instances | commits | mounts | updates |
| ------------------ | --------- | ------- | ------ | ------- |
| `session-switch`   | 726 → 229 | 750→253 | 51→51  | 699→202 |
| `file-tree-expand` | 112 → 84  | 129→112 | 53→53  | 76→59   |

`FileTreeItem`, `FileTreeItemMenu`, `DirectoryEntries` and `ControlledViewProvider` left the
Session-switch sample entirely. What remains is tracked rather than unexplained:

- The 51 mounts are the `PaneView` subtree of a Session not yet in the workbench's recently used
  keep-alive set; a switch between retained Sessions should mount nothing, so mounts there are a
  finding.
- The ~200 remaining updates were the 5 Session cards and their menu wrappers. Issue #1108 took
  two wrong answers before issue #1356 measured the right one, and both are instructive.

  The first wrong answer: "`app.bootstrap` is replaced wholesale, so every derived array is a new
  reference". False — `mergeStructurally` keeps every unchanged record's identity. The second wrong
  answer over-corrected: a structural-sharing test that only changed `selectedSessionId` "proved"
  `sessions`/`projects` survive a switch. A real switch does more than that: the Server stamps
  `lastOpenedAt` on the opened Session and on its Project, so both arrays and those two records
  arrive as new objects, while every other record and `terminals` keep their identity.
  `stores/structural-sharing.test.ts` now locks that real shape. A synthetic snapshot proves only
  what it contains; compare against the payload the interaction actually produces.

  Issue #1108 then wrapped `use-session-order.ts` and `use-session-rename.ts` in
  `useCallback`/`useMemo`, because React Compiler bails out of both (a destructuring-default arrow
  and a `try`/`finally` without `catch` in one, an ESLint suppression in the other; verified by
  running the pinned `babel-plugin-react-compiler` with a `logger`). That landed as #1354 without a
  re-sample, on the claim that the card component compiles cleanly and "would otherwise have
  skipped the re-render".

### Measuring #1354 (issue #1356)

Method: 1 Project with 5 Shell Sessions, window 1440×900 (inner 1440×837 at 2×), each build on its
own isolated dev instance. Visit Sessions 2, 3, 4, 5, then 1, so the keep-alive set is {1, 5, 4};
discard one warm-up sample (§5); then sample `--label session-switch --within PrimarySidebar
--seconds 30` for three retained switches (to 1, 5, 1) and one cold switch (to 2).

| Build                        | Sidebar, retained switch | Window, retained switch   | Sidebar, cold switch |
| ---------------------------- | ------------------------ | ------------------------- | -------------------- |
| Before #1354 (`0403756e5`)   | 88 / 88 / 88             | 177 / 200 / 177 instances | 88                   |
| After #1354 (`0fb1845cb`)    | 88 / 88 / 88             | 177 / 200 / 177 instances | 80                   |
| `main` at the start of #1356 | 86 / 86 / 86             | 175 / 198 / 175 instances | 82                   |
| #1356 fix                    | 49 / 49 / 49             | 138 / 161 / 138 instances | 49                   |

Every sidebar instance in those rows is an update: a switch mounts nothing in the sidebar. **#1354
changed nothing**; its memoization was sound but everything it keyed on still moved. Five
identities reached every row on each switch:

1. The `useSessionOrder` controller and the rename handlers depended on the `sessions` array, which
   the `lastOpenedAt` stamp replaces, so the memoized objects were rebuilt anyway.
2. Each row received the whole `project` record, which the same stamp replaces.
3. Each row received an inline `onBeginRename` closure.
4. Each row received its own freshly filtered `visibleSessions` array.
5. There was no `memo` boundary. React Compiler caches a parent's `.map()` block as a whole, so
   when any input of that block changes — and `selectedSessionId` always does — every row element
   is recreated and every compiled child renders again. A cleanly compiled child skips nothing on
   its own; only a `memo` boundary compares its props.

The fix: stable handlers read the current list through `useLatestReference` (a layout effect, so
no event reads a stale list) instead of depending on it; rows get the Project's display fields
instead of the record, the shared `onBeginRename` instead of a per-row closure, and one
content-keyed `visibleSessionIds` array per list (`useVisibleSessionIds`); both lists render
`memo(ActiveSessionRow)`. `session-order.test.ts` locks the id-list key across a record
replacement.

What still renders is expected: the two rows whose `selected` flipped (`ActiveSessionRow` 5 → 2,
and the same for `SessionRowTrigger`, `SessionRowMenu`, `SessionActivityCard`; `HoverCard` and
`ContextMenuTrigger` 6 → 3 with the Project row's own), the Project heading whose record the Server
stamped, and the tree shell that reads `selectedSessionId`. The whole-window mounts (18 or 41 on a
retained switch, 136 on the cold one) belong to the pane, not the sidebar, and did not change.

The lesson for the next render fix: re-sample before calling it done, and scope the sample to the
surface under repair. A cause is confirmed by the count dropping, not by the code looking memoized.

## 7. Naming the cause

A render finding must name the avoidable cause — the prop, state, context, or hook identity that
moved. This script deliberately does not diff Fiber inputs: react-scan 0.5.7 has no supported option
for it, and a guessed cause is worse than none. When the table shows an anomaly, hand it to the
`react-rerender-audit` skill, which localizes the owning hook and the remount boundary, and can add
a Profiler regression test. Counts without a named cause go into the report as observations, never
into a fix batch.

## 8. Privacy

Only component names, per-instance counts, and timestamps leave the page. Never extend the collector
with DOM text, prop or state values, or paths: this output is pasted into audit reports, and
`AGENTS.md` forbids source contents, Terminal output, transcripts, and secret-like settings in
diagnostics.
