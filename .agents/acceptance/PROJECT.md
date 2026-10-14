# Caxri Acceptance Adapter

## 1. Project summary

Caxri is a macOS-first Electron workbench with an Expo/React Native mobile companion. Electron Main
owns desktop windows and lifecycle, Preload exposes the typed `window.caxri` bridge, the Renderer
owns desktop UI, and the detached Server Core owns PTYs, Git, files, SQLite, settings, Agent
adapters, mobile access, and the encrypted mobile gateway. The scriptable `caxri` CLI is a separate
product surface over that same Server. Acceptance uses the real macOS Electron, `caxri` CLI,
Android, and iOS Simulator product surfaces.

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
  Add Project flow without opening the native folder picker, and writes ownership state to
  `.records/acceptance/runtime.json`.

- **Multiple Projects:** repeat `--test-root PATH` to queue deterministic folder-picker results.
  The final root remains selected after the queue is exhausted, so Acceptance never falls through
  to a native dialog.

- **Agent fixtures:** Every Acceptance launch uses isolated HOME, XDG directories, provider homes,
  and shell PATH entries beneath the owned user-data directory; blocked Agent shims are the default.
  When the frozen plan declares
  `"agentFixture": "agent-features-v1"`, pass `--agent-fixture agent-features-v1` to the launcher.
  The adapter replaces only the blocked Claude Code and Codex targets with fixed fake executables.
  It rejects arbitrary ids and host executable paths and
  records `assets/<case-id>-agent-fixture.json`; include that receipt in the case evidence.
  A restart case may call the closed
  `setAcceptanceAgentFixtureProviderAvailability` adapter between launches to mark only the fixed Codex provider
  unavailable under `agent-features-v1`. Each launch receipt records its actual `availableProviders`; omitted providers
  remain blocked by the fixture environment and never fall back to a host executable.
  The fixed `grok-build-v1` fixture replaces only Grok and renders a bounded synthetic grid for
  Session identity, turn outcome, and restart checks; host Grok remains blocked.
  The fixed `agent-chat-v1` fixture makes Claude Code and Codex the deterministic Agent Chat fakes for
  Chat transcript, approval, and composer checks; see `surfaces/electron.md` in the acceptance skill.

- **Native dialogs:** these are manual Acceptance boundaries by default. Keep the deterministic
  test-root environment and stub Main's dialog result for automated coverage. Hand dialog-specific
  checks to the user. Only when the current user request explicitly asks the agent to verify native
  UI may the agent prefix each native command with
  `CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request` and add `--native-dialog`;
  the launcher and native helpers otherwise fail closed.
  A case that clicks **Import Theme** declares `"themeImportFixture": true` in the frozen plan; the
  launcher then enables a narrower theme-file selection fixture for exactly that case.
  `report.ts init` refuses a desktop item whose id, title, method, or expected text mentions theme
  import without the declaration (use `false` when the case deliberately does not use the fixture), and
  Main rejects an unarmed Acceptance **Import Theme** with an error instead of opening the real
  macOS panel. Only a case declaring `false`, launched with the native-dialog authorization marker,
  may reach the real panel; the marker alone never does. A `true` case cannot use
  `--native-dialog`. Put the import file inside the first `--test-root`, then write
  `{ "caseId": "<current case>", "relativePath": "<path within test root>", "sequence": 1 }`
  to `acceptance-theme-import-command.json` in the owned runtime's `userDataDir` before clicking
  **Import Theme**. Increase `sequence` for each selection. Main records
  `acceptance-theme-import-receipt.jsonl`; copy it into the case assets before stopping the app.
  This controls only the file choice, not the import or its native dialog appearance.

- **Update notification:** unpackaged Acceptance builds never contact the release service. A case
  that must show update UI declares `"updateFixture": "available"`; the launcher arms
  `CAXRI_ACCEPTANCE_UPDATE` for exactly that case, and Main
  (`apps/desktop/src/main/acceptance-update.ts`) replaces only GitHub release discovery with the
  fixed release `999.0.0`. The launch check then publishes it through the real update state path,
  so the Renderer's notification and **Check for Updates** dialog render normally. The fixture is
  served once per launch; later checks re-read that state. Download and install stay disabled and
  report an error if clicked. A packaged build or a launch outside the Acceptance and E2E gates
  ignores the variable; inside Acceptance any other value shows a check error. Main appends the
  served case to `acceptance-update-receipt.jsonl` in the owned `userDataDir`; copy it into the
  case assets as proof the update was the fixture, not a real release.

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
  immutable launcher/window identities recorded in the runtime file plus the Server Core that owns
  that profile's kernel lock and its exact artifact children. It rechecks every identity before
  signaling, preserves state on a mismatch or timeout, and does not return success until CDP and all
  captured owned processes are gone. A live launcher owns its own teardown: it receives SIGTERM
  alone and is force-killed only after `--launcher-grace-ms` (default 30000) without teardown
  progress, or once three grace periods have elapsed regardless of progress; the adapter logs the
  measured teardown duration and then completes the case's state-isolation receipt itself, so that
  receipt is whole after every successful stop. The Agent-fixture receipt of a fixture-backed case is
  still written only by the launcher; a fixture launch stranded by a force-kill has no repair
  command yet.
- **Already-running detection:** the adapter compares the recorded launcher PID
  and immutable process identity. It refuses to replace a verified live owner
  and treats a recycled PID as stale state. A declared restart may carry the same verified Server Core
  generation into its next launch only when the case, canonical profile, and worktree all match.
  State written before Server ownership was verified is preserved for inspection rather than
  being treated as safely stale.
- **CDP resolution:** read `port` and `cdpUrl` from the runtime file or from the
  JSON readiness line printed by the start script. Do not assume another Caxri
  instance uses the same port.
- **Required services:** none beyond the local Caxri Desktop, detached Server processes, and the
  explicitly selected native device for a mobile case. Mobile acceptance never uses a cloud Expo
  or EAS account.

### Caxri CLI acceptance

Build the standalone bundle, then drive it against the isolated launch's own profile:

```bash
bun run build:cli
node apps/cli/dist/caxri.cjs --profile "$USER_DATA_DIR" project list --json
```

`$USER_DATA_DIR` is the `userDataDir` recorded in `.records/acceptance/runtime.json`; it is also
the `CAXRI_USER_DATA_DIR` environment equivalent. The bundle requires Node.js 24 or newer, and
Agent and CI invocations never start a Server implicitly, so start the isolated desktop first.
`--help` and `capabilities --json` are the only commands that work without a Server. Every mutation
additionally requires `--yes` and should carry a stable `--request-id`. The plan item uses
`surface: "cli"` and keeps the same `stateIsolation` receipt as a desktop case.

### Android release acceptance

The guarded cross-device path accepts only one explicit disposable emulator serial. Before touching
the device it requires a clean worktree at the frozen report commit. It regenerates the native
project, installs the release APK, clears only
`com.caxri.mobile`, and records report-bound lifecycle and result receipts:

```bash
CAXRI_MOBILE_ACCEPTANCE_SERIAL=emulator-5554 \
CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR="$REPORT_DIR" \
CAXRI_MOBILE_ACCEPTANCE_CASE_ID="android-short-reply" \
  bun run test:e2e:mobile:android
```

The plan item must use `surface: "mobile"`, `stateIsolation.mode: "isolated"`, and a matching
`mobileDevice` object. Include
`assets/android-short-reply-state-isolation.json` and
`assets/android-short-reply-mobile-device.json` and
`assets/android-short-reply-result.json`, plus the generated `-android.png` and `-android.mp4`, in
`cases[].evidence`. The runner owns one bounded `screenrecord` process and captures the final PNG
directly from the device framebuffer before cleanup. Every child command is bounded by a stage
timeout and the overall run deadline. A clean retry atomically replaces its prior result receipts,
and finalization binds them to the report commit and final lifecycle launch. Do not use this command
on a physical device; its data reset is intentionally emulator-only.

### iOS Simulator build

Use one explicit Simulator UDID and do not start another Metro process:

```bash
bun run --cwd apps/mobile ios -- --device <simulator-udid> --no-bundler
xcrun simctl launch --terminate-running-process <simulator-udid> com.caxri.mobile
```

When Expo config or native plugins changed, first run:

```bash
bun run --cwd apps/mobile prebuild:ios -- --clean
```

`xcode-select -p` must resolve to the full Xcode Developer directory and CocoaPods must already be
installed. Acceptance may report either prerequisite as missing but must not install or switch
developer tools without explicit authorization.

## 3. Auth

Caxri itself has no account login. Acceptance publication uses the operator's
existing authenticated `lh` CLI session and must be checked separately with:

```bash
lh whoami --json
```

### Project hook trust

Codex loads `.codex/hooks.json` only from a trusted project, and each exact hook definition must be
reviewed separately. On a new clone, or after this hook configuration changes, open `/hooks`, review
the project hook, and trust its current definition. Codex records trust against the definition hash,
so an edited hook remains disabled until it is reviewed again. See the
[official Codex Hooks guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

After trusting the hook, run this harmless probe from the repository:

```bash
caxri-acceptance-hook-self-test
```

The hook must deny the command with rule `caxri-acceptance-hook-self-test`. A shell
`command not found` response means the project hook did not run; inspect `/hooks` before Acceptance.
Claude Code loads the same repository hook through `.claude/settings.json`; after accepting the
project settings, use the same self-test and treat `command not found` as a missing hook there too.

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

### Android

- **Lifecycle and full reply path:** use the guarded release acceptance command above on a
  disposable emulator.
- **Semantic inspection:** `bun run --cwd apps/mobile android:device semantics --serial <serial>`.
- **Interaction:** `bun run --cwd apps/mobile android:device tap --serial <serial> --check-id <id>`.
- **Evidence:** ADB device screenshot plus sanitized semantic/result receipts. Never retain or
  upload raw UIAutomator XML.
- **Physical devices:** user-owned and opt-in. The user unlocks and authorizes the device; Acceptance
  does not clear package data, uninstall, reboot, stop, or change its settings.

### iOS Simulator

- **Lifecycle and capture:** `xcrun simctl` with one explicit UDID.
- **Interaction:** an already-installed native Accessibility/HID CLI such as AXe, or a repository
  XCUITest driver. Host-window clicks are smoke checks only.
- **Evidence:** Simulator framebuffer screenshot/video plus Accessibility hierarchy before/after
  when the hierarchy is safe. Do not upload any artifact containing pairing data or private content.
- **Ownership:** never erase a user-owned Simulator. A mutating acceptance case needs a Simulator
  explicitly designated as disposable and documented app-container cleanup.

## 5. Project probes and navigation

- **CDP ready:** `curl --fail --silent http://127.0.0.1:<port>/json/version`.
- **Targets:** `curl --fail --silent http://127.0.0.1:<port>/json/list`; select
  the Caxri renderer and reject a `devtools://` target.
- **Renderer snapshot:** `agent-browser --cdp <port> snapshot -i`.
- **Renderer frame/DOM capture:**
  `bun run .agents/skills/acceptance/scripts/capture-renderer.ts --help`; it
  validates runtime ownership and supports `--url-contains` for secondary Caxri
  windows.
- **Desktop and Server logs:** the isolated user-data directory recorded in
  `.records/acceptance/runtime.json` owns packaged/test logs. Development logs
  may also appear under `logs/`. Copy any cited excerpt into the current round's
  `assets/` directory before stopping the isolated app.
- **Project fixture:** pass purpose-built fixture folders through one or more `--test-root`
  options; defaulting to the repository root is appropriate only when the acceptance case needs a
  real large Project.
- **Agent fixture:** declare the fixed repository-owned fixture in the plan and pass its id through
  `--agent-fixture`; never expose a host Claude Code or Codex installation to Acceptance.
- **Quick navigation:** no hidden app-state mutation contract exists. Prefer the
  shortest user-visible path or a committed E2E fixture helper.
- **Android device identity:**
  `bun run --cwd apps/mobile android:device inspect --serial <explicit-adb-serial>`.
- **Android semantic state:**
  `bun run --cwd apps/mobile android:device semantics --serial <explicit-adb-serial>`.
- **iOS devices:** `xcrun simctl list devices booted --json`; choose one UDID and stop using
  `booted` in later commands.
- **iOS toolchain:** `xcodebuild -version`, `xcode-select -p`, and `command -v pod`.
- **iOS native driver:** probe `command -v axe`, then `idb` and `idb_companion`; missing tools block
  interaction evidence rather than authorizing installation.

## 6. Known constraints

- Run Acceptance on macOS. Desktop cases use an isolated Electron app; mobile cases use the exact
  Android emulator, physical device, or iOS Simulator declared in the plan and evidence.
- A stale `out/` bundle invalidates screenshots. Build before launch and restart
  after Desktop Main, Preload, Renderer, or Server changes; Renderer reload alone is insufficient.
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
- The Android release round intentionally accepts only `emulator-<number>` serials. Wi-Fi and USB
  physical-device serials are supported by diagnostic helpers, not by the destructive data-reset
  runner.
- Phase one reconnects only to Mac addresses captured during pairing. A DHCP or network change can
  require **Forget** and re-pair; do not report that documented limitation as an acceptance harness
  failure.
- Emulator and Simulator observations are not physical-device release-performance evidence. Use
  `docs/mobile/performance.md` and a named physical device for such a criterion.
- Pairing links and QR codes are credentials. If one appears in a screenshot, raw hierarchy, log,
  or recording, invalidate the artifact and capture a fresh isolated case.

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
- [`references/mobile-runtime.md`](references/mobile-runtime.md): native toolchains, explicit device
  ownership, build freshness, pairing privacy, and mobile cleanup facts.

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
