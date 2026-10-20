# Caxri Electron agent-browser reference

Use `agent-browser` only against the isolated Caxri Electron renderer. Read the
actual port from `.records/acceptance/runtime.json`; never use auto-connect or
attach to a developer-owned app.

## Connect and prove the target

Create a unique session name for the round. Repeat `--session "$SESSION"
--no-pin-tab --cdp "$PORT"` on every command. Electron's raw CDP endpoint does
not implement the `Target.createTarget` operation used by `--pin-tab`.
Before interacting, confirm the selected page is the Caxri renderer:

```bash
SESSION="acceptance-<issue>-<round>-<random>"
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" get url
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" get title
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" snapshot -i
```

The URL must resolve to Caxri's renderer output and must not use the
`devtools://` scheme. Inspect `http://127.0.0.1:$PORT/json/list` if target
selection is ambiguous.

## Interact

Use a fresh snapshot to obtain element references, then drive the smallest path
that proves the Acceptance check:

```bash
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" snapshot -i
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" click @e1
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" fill @e2 "value"
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" press Enter
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" wait --text "Expected state"
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" snapshot -i
```

Right-click menus are native macOS menus owned by Main, so they never appear in
a DOM snapshot and CDP cannot choose their items. `agent-browser click` is also
left-click only; it does not accept `--button right`. To show a menu for visual
evidence, resolve the target element's viewport center with a bounded `eval`,
then use `mouse move <x> <y>`, `mouse down right`, and `mouse up right` against
the same Session and CDP port, and capture it with a window screenshot rather
than a CDP page screenshot. Dismiss it with Escape before continuing. To assert a
menu's entries or run one, use the E2E probe in
`e2e/support/native-context-menu.ts` instead.

References become stale after navigation, renderer reload, or meaningful DOM
replacement. Snapshot again before the next interaction.
`snapshot -i` lists interactive controls and can omit the static explanation of
an error or empty state. Read the full snapshot or inspect a screenshot before
concluding that the product did not explain the state.

Use semantic locators when they describe the user path more clearly:

```bash
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" find role button click --name "Add Project"
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" find placeholder "Search" type "query"
```

## Inspect and capture

Use `eval --stdin` for structured renderer observations and stringify objects so
the captured result is stable:

```bash
agent-browser --session "$SESSION" --no-pin-tab --cdp "$PORT" eval --stdin <<'EVALEOF'
JSON.stringify(
  {
    title: document.title,
    url: location.href,
    viewport: { height: innerHeight, width: innerWidth },
  },
  null,
  2,
)
EVALEOF
```

Capture settled Renderer state through the owned-runtime helper and its explicit
output option:

```bash
bun run .agents/skills/acceptance/scripts/capture-renderer.ts screenshot \
  --output "$ARTIFACT_PATH"
```

Do not use raw `agent-browser screenshot` for Acceptance evidence: its positional
arguments can interpret an output path as a selector. The helper also validates
the owned runtime and exact Renderer target. This screenshot command is valid
only for a case with no fixture preflight. When the frozen plan declares
`fixturePreflight: terminal`, first write the ready preflight receipt to the
case's fixed `assets/<case-id>-fixture-preflight.json` path and include it in
`cases[].evidence`. `report.ts finalize` rejects the screenshot verdict if that
receipt is missing or blocked.

For temporal Renderer evidence, use `capture-renderer.ts frames`. Pass
`--fixture-preflight` only when the frozen plan declares the Terminal fixture preflight; the owned
runtime receipt lets non-Terminal interactions record frames without inventing a grid receipt.

Capture a required `dom_snapshot` as a real `.html` artifact from the smallest
semantic subtree that supports the observation. Choose a selector specific to
the check instead of serializing the entire page:

```bash
bun run .agents/skills/acceptance/scripts/capture-renderer.ts dom \
  --output "$ARTIFACT_DIR/check-dom.html" \
  --selector "main"
```

The capture helper reads and validates the port from the owned Acceptance
runtime. Add `--url-contains <text>` only when intentionally targeting a
secondary Caxri window.

Open the saved `.html` file and confirm it contains the intended settled state.
Do not use interactive `snapshot -i` text as a `dom_snapshot` artifact.

Open and visually inspect every image before recording a verdict.

## Boundaries

- CDP sees Renderer content, not macOS-owned window chrome or dialogs.
- Stop before a native sheet or app-modal window and hand it to the user. Follow
  [native-dialogs.md](native-dialogs.md) only for an explicit current-request exception.
- A DOM snapshot supports structure but does not replace visual evidence for a
  layout claim.
- A static screenshot does not prove behavior over time; follow
  [recording-cdp.md](recording-cdp.md).
- Stop only the owned Electron process with the project adapter. Do not use
  broad process-name kills or close a resident Caxri instance.
- Each `--session` is its own daemon and browser, and it outlives the calling
  command. Export `AGENT_BROWSER_IDLE_TIMEOUT_MS` (for example `1800000`) before
  the first call so an abandoned session shuts itself down, and run
  `agent-browser --session "$SESSION" close` at teardown. Close only the session
  this round opened: `close --all` or `pkill -f agent-browser` kills sibling
  sessions' browsers mid-capture.
