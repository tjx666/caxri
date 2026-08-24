# Caxri Electron agent-browser reference

Use `agent-browser` only against the isolated Caxri Electron renderer. Read the
actual port from `.records/acceptance/runtime.json`; never use auto-connect or
attach to a developer-owned app.

## Connect and prove the target

Repeat `--cdp "$PORT"` on every command. Before interacting, confirm the selected
page is the Caxri renderer:

```bash
agent-browser --cdp "$PORT" get url
agent-browser --cdp "$PORT" get title
agent-browser --cdp "$PORT" snapshot -i
```

The URL must resolve to Caxri's renderer output and must not use the
`devtools://` scheme. Inspect `http://127.0.0.1:$PORT/json/list` if target
selection is ambiguous.

## Interact

Use a fresh snapshot to obtain element references, then drive the smallest path
that proves the Acceptance check:

```bash
agent-browser --cdp "$PORT" snapshot -i
agent-browser --cdp "$PORT" click @e1
agent-browser --cdp "$PORT" fill @e2 "value"
agent-browser --cdp "$PORT" press Enter
agent-browser --cdp "$PORT" wait --text "Expected state"
agent-browser --cdp "$PORT" snapshot -i
```

References become stale after navigation, renderer reload, or meaningful DOM
replacement. Snapshot again before the next interaction.

Use semantic locators when they describe the user path more clearly:

```bash
agent-browser --cdp "$PORT" find role button click --name "Add Project"
agent-browser --cdp "$PORT" find placeholder "Search" type "query"
```

## Inspect and capture

Use `eval --stdin` for structured renderer observations and stringify objects so
the captured result is stable:

```bash
agent-browser --cdp "$PORT" eval --stdin <<'EVALEOF'
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

Capture settled Renderer state to an explicit path:

```bash
agent-browser --cdp "$PORT" screenshot "$ARTIFACT_PATH"
```

This direct screenshot command is valid only for a case with no fixture preflight. When the frozen
plan declares `fixturePreflight: terminal`, first write the ready preflight receipt to the case's
fixed `assets/<case-id>-fixture-preflight.json` path and include it in `cases[].evidence`.
`report.ts finalize` rejects the screenshot verdict if that receipt is missing or blocked.

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
