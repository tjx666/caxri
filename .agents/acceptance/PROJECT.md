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
  outputs and refuses a bundle whose embedded commit differs from the frozen
  Acceptance report commit.
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

- **Native dialogs:** these are manual Acceptance boundaries by default. Keep the deterministic
  test-root environment and stub Main's dialog result for automated coverage. Hand dialog-specific
  checks to the user. Only when the current user request explicitly asks the agent to verify native
  UI may the agent prefix each native command with
  `CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request` and add `--native-dialog`;
  the launcher and native helpers otherwise fail closed.

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

- **Stop:** `bun run .agents/skills/acceptance/scripts/stop-electron.ts`. The adapter stops only the
  immutable launcher/window identities recorded in the runtime file plus the Host that owns that
  profile's kernel lock and its exact worktree Runtime child. It rechecks every identity before
  signaling, preserves state on a mismatch or timeout, and does not return success until CDP and all
  captured owned processes are gone.
- **Already-running detection:** the adapter compares the recorded launcher PID
  and immutable process identity. It refuses to replace a verified live owner
  and treats a recycled PID as stale state. A declared restart may carry the same verified Host
  generation into its next launch only when the case, canonical profile, and worktree all match.
  State written before Host/Runtime ownership was verified is preserved for inspection rather than
  being treated as safely stale.
- **CDP resolution:** read `port` and `cdpUrl` from the runtime file or from the
  JSON readiness line printed by the start script. Do not assume another Caxri
  instance uses the same port.
- **Required services:** none beyond the local Caxri Main and Runtime processes.

## 3. Auth

Caxri itself has no account login. LobeHub publication uses the developer's
existing production CLI authentication and must be checked separately with:

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
- **Native dialogs:** stop before system UI and hand the check to the user. The semantic helper is an
  explicit-user-request exception only; never infer authorization from a general Acceptance run.
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
  A commit created after the last build is stale even when file mtimes appear
  current; the adapter compares the build stamp with `result.json` before launch.
- Never run the full local Electron E2E suite. Use focused Playwright coverage
  and leave the full suite to PR CI.
- A static screenshot cannot prove streaming, replay, loading, animation, or
  other temporal behavior; record it.
- Desktop evidence proves observable product behavior, not hidden callback
  ordering. Pair the visible outcome with a focused test or log receipt when
  the ordering itself has no desktop marker.
- Visually inspect every captured image. A blank or stale renderer can still
  contain plausible DOM text.
- Do not resize the Electron window after the scenario begins unless resizing is
  the behavior under test; it can invalidate state and evidence.

## 7. Project learning log

These files hold Caxri-specific field knowledge behind the rules above. Read the
entries relevant to the planned round before improvising a new setup or evidence
method:

- [`common-mistakes.md`](common-mistakes.md): mistakes that consumed
  or invalidated an Acceptance run.
- [`probe-mock-patterns.md`](probe-mock-patterns.md): reusable
  deterministic probe and mock techniques.
- [`references/desktop-runtime.md`](references/desktop-runtime.md):
  desktop ownership, lifecycle, build freshness, and focus facts.
- [`references/fixtures.md`](references/fixtures.md): Project roots,
  state isolation, and deterministic fixture contracts.

The reusable Acceptance workflow remains in `.agents/skills/acceptance/`;
project-specific observations belong here so the skill does not become an
unstructured incident log.

**Where new learnings go:**

- A mistake that cost a run goes to `common-mistakes.md`.
- A reusable probe or mock technique goes to `probe-mock-patterns.md`.
- An environment, lifecycle, or fixture fact goes to the matching
  `references/` file.

Stop the owned desktop before updating these files. Add only facts confirmed by
an actual run or repository contract, merge duplicate advice, and link back to
the canonical skill rule when a field note explains why that rule exists.
