# macOS Electron desktop surface

Use this surface for Caxri's macOS Electron product behavior. Follow
`.agents/acceptance/PROJECT.md` to build and start an isolated app, then read
`port` from `.records/acceptance/runtime.json`:

```bash
PORT=<recorded-port>
ARTIFACT_DIR="$ROUND_DIR/assets"
agent-browser --cdp "$PORT" get url
agent-browser --cdp "$PORT" snapshot -i
```

The URL must belong to the Caxri Renderer. If target selection is ambiguous,
inspect `http://127.0.0.1:$PORT/json/list` and reject `devtools://` targets.

## Prove the planned path

1. Drive the shortest real Renderer interaction that reaches the planned state.
2. Re-snapshot after navigation, reload, or meaningful DOM replacement.
3. Capture settled visual state and supporting DOM evidence into
   `$ARTIFACT_DIR`; follow
   [../references/agent-browser.md](../references/agent-browser.md).
4. For streaming, replay, loading, animation, or another temporal claim, follow
   [../references/recording-cdp.md](../references/recording-cdp.md).
5. Copy any required Main or Runtime log excerpt into `$ARTIFACT_DIR` before
   stopping the app; the adapter removes its isolated user-data directory.

CDP excludes macOS-owned window chrome and system dialogs. Native dialogs are manual Acceptance
boundaries by default: use a deterministic Main stub to prove the product state on either side, and
give the dialog-specific observation to the user. Do not trigger system UI. Only a current user
request explicitly asking the agent to verify a native dialog permits the fail-closed exception in
[../references/native-dialogs.md](../references/native-dialogs.md).

## Finish

Stop only the owned launcher:

```bash
bun run .agents/skills/acceptance/scripts/stop-electron.ts
```

Never use a broad process-name kill or a command that closes unrelated automation
sessions.
