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

Capture settled renderer state with the explicit `html` selector:

```bash
agent-browser --cdp "$PORT" screenshot html "$ARTIFACT_PATH"
```

Do not replace `html` with `body`: Caxri's layout can produce a one-pixel body
capture even when the app is fully rendered. Open and visually inspect every
image before recording a verdict.

## Boundaries

- CDP sees Renderer content, not macOS-owned window chrome or dialogs.
- A DOM snapshot supports structure but does not replace visual evidence for a
  layout claim.
- A static screenshot does not prove behavior over time; follow
  [recording-cdp.md](recording-cdp.md).
- Stop only the owned Electron process with the project adapter. Do not use
  broad process-name kills or close a resident Caxri instance.
