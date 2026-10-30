# Probe / Mock Patterns: Caxri

Reusable Caxri-specific techniques for producing fast, deterministic, and
reviewable Acceptance evidence. Environment and fixture facts belong in
[`references/`](references/); mistakes that cost a run belong in
[`common-mistakes.md`](common-mistakes.md).

## Cross a native dialog boundary with a deterministic Main result

**Situation:** The behavior under test starts before a native open, save, or
confirmation dialog and finishes in the Renderer, Runtime, configuration, or
filesystem.

**Does not work:** Automating the macOS window merely to prepare state, or
replacing the entire product path with a mock that bypasses the owning Main
handler. The first approach is slow and focus-stealing; the second proves only
the test double.

**Works:** Keep the real product path on both sides of the boundary and control
only the dialog response:

1. Stage the exact file or directory fixture inside the authorized test root.
2. For Project selection, pass one or more `--test-root` values to the Acceptance
   launcher; it supplies `CAXRI_TEST_ROOT_PATH` / `CAXRI_TEST_ROOT_PATHS` without
   opening a picker.
3. For other dialogs, stub `dialog.showOpenDialog`, `dialog.showSaveDialog`, or
   `dialog.showMessageBox` at Electron Main's boundary and return the intended
   cancel or confirm result.
4. Assert the resulting user-visible state and the narrowest durable side effect.
   Use a focused Main test when the dialog-response mapping itself is the claim.
5. Report the native surface as manual or unverified unless the current request
   explicitly authorized native-dialog verification.

Existing examples include `apps/desktop/src/main/__tests__/workbench-root-authority.test.ts`,
`apps/desktop/src/main/__tests__/main-methods-dialogs.test.ts`, and the focused Electron specs
that set `CAXRI_TEST_ROOT_PATHS`.

For a theme Acceptance case whose frozen plan declares `"themeImportFixture": true`, the launcher
and `apps/desktop/src/main/acceptance/theme-import.ts` provide the file-picker result through a
per-profile command file. The command must name the active case, an increasing positive sequence,
and a regular file relative to the first test root. Main records each accepted choice before
forwarding the real `theme.importPath` request. Inspect the receipt and resulting Renderer state;
the fixture does not verify the native picker itself.

## Verify PR links without opening a native dialog or browser

The frozen `session-pr-open-parity` case has a fixed external-link fixture in
`apps/desktop/src/main/acceptance/external-open.ts`. The Acceptance launcher enables it only
for that case; Main also requires the Acceptance and E2E gates. It accepts only
`https://github.com/tjx666/project/pull/42` and never invokes a native confirmation or browser.
Before each real UI action, write an increasing positive `sequence` and one `decision`
(`confirm-success`, `cancel`, or `confirm-reject`) to
`acceptance-external-open-command.json` under the owned runtime's `userDataDir`.
The Main handler records its actual confirmation copy and the fixed open outcome in
`acceptance-external-open-receipt.jsonl` in the same profile. Copy and inspect that receipt
before the stop adapter removes the profile. The fixture never selects the trust action;
missing, repeated, malformed, or foreign inputs fail closed. This proves the surrounding
product flow and confirmation copy, not a native dialog or an external browser.

## Show update UI without a packaged build

**Failure:** Acceptance launches stay unpackaged, so `UpdateService` reports "available in packaged
Caxri builds" and no update notification can ever be captured.

**Works:** Declare `"updateFixture": "available"` in the frozen plan. Main
(`apps/desktop/src/main/acceptance/update.ts`) swaps only release discovery for the fixed `999.0.0`
release and runs the launch check, so the notification and **Check for Updates** dialog arrive
through the real update state path. Download and install stay disabled. Cite
`acceptance-update-receipt.jsonl` from the owned `userDataDir` beside the screenshot. The fixture
cannot prove GitHub discovery, the DMG download, or checksum verification; keep those in the
packaged release check.

## Queue deterministic Project choices without a picker

**Situation:** One Acceptance case must add or switch between multiple Projects.

**Works:** Repeat `--test-root PATH` in the intended selection order. The launcher
serializes the paths into `CAXRI_TEST_ROOT_PATHS`; Main consumes one path per
request and retains the final root after the queue is exhausted. This lets the
real authorization and Project flow run without falling through to native UI.
Use a fresh isolated case profile when the sequence mutates state.

## Inject the exact failure class a diagnostic claims to distinguish

**Situation:** A case must prove that Caxri classifies one specific failure correctly (a suspended
process, a reconnect window, a dropped-events advisory, a structurally impossible Git root) rather
than merely that the surrounding feature still works.

**Does not work:** Approximating the failure with load. High-frequency rewrites of the same files do
not overflow FSEvents, a busy event loop is not a suspended process, and renaming a fixture
repository away does not exercise repository discovery at all.

**Works:** Each of these injections was verified against an isolated instance and reproduces
deterministically:

- **Process suspension** (`process.event_loop_stall` with `stallKind: process-suspension`): `SIGSTOP`
  the launch's own Server Core for several seconds, then `SIGCONT`. The whole process freezes, so the
  next probe measures the full freeze as its interval while the CPU delta stays near zero; the same
  shape as a laptop lid-close, on one process.
- **A real reconnect window** (`ipc.request_failed` with `code: UNAVAILABLE`): `kill -9` Server Core.
  `SIGSTOP` does not work here: the Desktop connection has no heartbeat, so a frozen peer never
  closes its socket and the reconnect window never opens. Only an actual socket drop does.
- **FSEvents overflow** (`watch_hub.rescan`): churn directories, not file contents. Several rounds of
  creating ~120 subdirectories with ~60 files each and then deleting the round reliably overflows the
  kernel event queue and makes the upstream watcher emit must-rescan advisories.
- **Structural Git-discovery failure** (`git.summary` with `isRepository: false`): add a plain folder
  with no `.git` as a Project. This is the only injection that separates a cacheable structural
  failure from a transient one.

Copy the cited records into the round assets before stopping the instance; the isolated user-data
directory is temporary.

## Drive high-frequency Renderer requests from inside the page

**Situation:** A case must land many real requests inside a window that is open for about a second:
a reconnect window, a throttle interval, a cancellation race.

**Does not work:** Repeated `agent-browser` clicks or tab switches. Each CLI command is a full
round-trip of roughly a second, so at most one lands in the window, and tab switches often serve
cached data without issuing a request at all.

**Works:** Run one `agent-browser eval` containing a tight in-page loop over the committed E2E
bridge, `globalThis.caxri.request(method, params)`, and tally the resulting codes. This is the real
structured IPC contract, not a bypass, so the evidence stays at the product boundary while the
request rate is high enough to intersect a sub-second window. Start the loop first, then inject the
failure concurrently from the shell.

## Exercise Agent lifecycle behavior through fixed fake processes

The fixed Agent also supports Caxri's one low-cost transformation, automatic naming. It carries
Claude's title instructions in `--system-prompt` and Codex's instructions at the start of stdin;
the conversation stays on stdin. The fixture returns a fixed title without interpreting the
conversation. Unknown transformations still fail.

**Situation:** A desktop case needs Claude Code or Codex discovery, hooks, terminal interaction,
metadata, or provider-side renaming without using the developer's installed provider or data.

**Does not work:** Injecting a Main or Runtime Agent event, accepting an arbitrary executable path,
or inheriting host provider homes. Those paths either bypass the product boundary or expose private
state.

**Works:** Declare `"agentFixture": "agent-features-v1"` in the frozen plan and launch the case
with `--agent-fixture agent-features-v1`. Drive the fake from its real Session terminal using the
fixture commands documented in `.agents/skills/acceptance/scripts/agent-fixtures.ts`. The process
emits real provider hooks and metadata changes while keeping provider homes inside the owned
profile. Use the desktop result as primary evidence and the generated fixture receipt as audit
evidence; never cite its terminal output or synthetic transcript as product evidence.

## Drive Android by sanitized semantic identifiers

**Situation:** A native Android acceptance flow must find and activate a Caxri control without
capturing user-visible content.

**Works:** Give the React Native control a stable `testID`, inspect through
`bun run --cwd apps/mobile android:device semantics --serial <serial>`, and tap through
`android:device tap --check-id <id>`. The bridge proves Caxri owns the foreground Activity, parses the
temporary UIAutomator dump, emits only identifiers/flags/bounds, and removes the raw XML from device
and host. Re-inspect after navigation or native view replacement; never reuse stale bounds.

## Exercise mobile reply delivery with an isolated fake Agent

**Situation:** The end-to-end criterion must prove that an encrypted paired mobile client can reply
to one waiting Agent Session without invoking a developer's real Agent CLI.

**Works:** Use the guarded `test:e2e:mobile:android` runner. It creates a temporary Desktop/Server
profile and Project, enables hooks for one fake Agent, waits for the real `waiting` state, pairs the
release Android app, sends one fixed bounded reply, verifies the PTY received it once, disables
mobile access, removes the temporary profile, and clears emulator app data. The report receipt names
only the outcome and build/device identity; it never stores the pairing link or reply content.
