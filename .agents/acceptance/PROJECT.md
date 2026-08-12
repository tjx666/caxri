# Caxri Acceptance Adapter

## 1. Project summary

Caxri is a macOS-first Electron desktop workbench. Electron Main owns windows
and lifecycle, Preload exposes the typed `window.caxri` bridge, the Renderer owns
the UI, and the utility-process Runtime owns PTYs, Git, files, SQLite, settings,
and agent adapters. Acceptance uses the real macOS Electron desktop surface.

## 2. Environment

- **Dependencies:** `ni` when `node_modules/` is absent or stale.
- **Build:** `bun run build`. Rebuild whenever relevant `src/` files changed
  after the previous build. The start adapter rejects missing or stale process
  outputs.
- **Start isolated desktop:**

  ```bash
  bun run .agents/skills/acceptance/scripts/start-electron.ts \
    --port 9222 \
    --report-dir "$REPORT_DIR" \
    --case-id issue-42-terminal-layout \
    --test-root "$PWD"
  ```

  Run this as a long-lived process. It creates an isolated temporary user-data
  directory, enables `CAXRI_E2E=1`, makes the supplied root available to the
  Add Project flow without opening the native directory picker, and writes ownership state to
  `.records/acceptance/runtime.json`.

- **Multiple Projects:** repeat `--test-root PATH` to queue deterministic directory-picker results.
  The final root remains selected after the queue is exhausted, so Acceptance never falls through
  to a native dialog.

- **Restart with the same isolated profile:** create an empty temporary directory whose basename
  starts with `caxri-acceptance-user-<profile-id-length>-<profile-id>-`, pass the same `--case-id`,
  `--case-mode restart`, and `--reuse-user-data PATH` on both launches, and add
  `--cleanup-reused-user-data` only to the final launch. The adapter resolves the real path,
  binds it to the named restart case, requires it to remain beneath the OS temp directory, and
  refuses arbitrary developer profiles.

- **Case isolation:** the report plan records `stateIsolation`. Start every `isolated` mutating
  case in its own launch/profile regardless of execution order. Only a declared restart case can
  reuse a profile; do not rely on another case's selected Session, archive state, settings, or
  cleanup side effects. The adapter reads `--report-dir`, rejects a launch that differs from the
  frozen plan, and maintains the case's `assets/<case-id>-state-isolation.json` receipt. Include
  that receipt in `cases[].evidence`; finalization verifies exact profile reuse and cleanup.

- **Stop:** `bun run .agents/skills/acceptance/scripts/stop-electron.ts`. Stop only the
  process recorded in the runtime file.
- **Already-running detection:** the adapter compares the recorded launcher PID
  and immutable process identity. It refuses to replace a verified live owner
  and treats a recycled PID as stale state.
- **CDP resolution:** read `port` and `cdpUrl` from the runtime file or from the
  JSON readiness line printed by the start script. Do not assume another Caxri
  instance uses the same port.
- **Required services:** none beyond the local Caxri Main and Runtime processes.

## 3. Auth

Caxri itself has no account login. LobeHub publication uses the operator's
authenticated CLI session and must be checked separately with:

```bash
lobehub acceptance run list --json
```

## 4. Surface

### macOS Electron desktop

- **Launch:** use the isolated start command from section 2.
- **CDP:** `agent-browser --cdp <port>` against the Caxri renderer target.
- **Evidence:** renderer screenshot and DOM snapshot for settled UI; CDP frame
  recording for temporal behavior; focused test or log artifacts as supporting
  text evidence.
- **Native dialogs:** inspect and click exactly one Accessibility button in an
  owned sheet or app-modal window with
  `bun run .agents/skills/acceptance/scripts/native-dialog.ts`; never use screen
  coordinates or re-trigger the command while a dialog may be open.
- **Resident app:** never attach to or close a developer-owned Caxri instance.

## 5. Project probes and navigation

- **CDP ready:** `curl --fail --silent http://127.0.0.1:<port>/json/version`.
- **Targets:** `curl --fail --silent http://127.0.0.1:<port>/json/list`; select
  the Caxri renderer and reject a `devtools://` target.
- **Renderer snapshot:** `agent-browser --cdp <port> snapshot -i`.
- **Renderer frame/DOM capture:**
  `bun run .agents/skills/acceptance/scripts/capture-renderer.ts --help`; it
  validates runtime ownership and supports `--url-contains` for secondary Caxri
  windows.
- **Main and Runtime logs:** the isolated user-data directory recorded in
  `.records/acceptance/runtime.json` owns packaged/test logs. Development logs
  may also appear under `logs/`. Copy any cited excerpt into the current round's
  `assets/` directory before stopping the isolated app.
- **Project fixture:** pass purpose-built fixture directories through one or more `--test-root`
  options; defaulting to the repository root is appropriate only when the acceptance case needs a
  real large Project.
- **Quick navigation:** no hidden app-state mutation contract exists. Prefer the
  shortest user-visible path or a committed E2E fixture helper.

## 6. Known constraints

- Run Acceptance on macOS against the isolated Electron desktop app.
- A stale `out/` bundle invalidates screenshots. Build before launch and restart
  after Main, Preload, or Runtime changes; Renderer reload alone is insufficient.
- Never run the full local Electron E2E suite. Use focused Playwright coverage
  and leave the full suite to PR CI.
- A static screenshot cannot prove streaming, replay, loading, animation, or
  other temporal behavior; record it.
- Visually inspect every captured image. A blank or stale renderer can still
  contain plausible DOM text.
- Do not resize the Electron window after the scenario begins unless resizing is
  the behavior under test; it can invalidate state and evidence.
