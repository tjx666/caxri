# Probe / Mock Patterns — Caxri

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

## Queue deterministic Project choices without a picker

**Situation:** One Acceptance case must add or switch between multiple Projects.

**Works:** Repeat `--test-root PATH` in the intended selection order. The launcher
serializes the paths into `CAXRI_TEST_ROOT_PATHS`; Main consumes one path per
request and retains the final root after the queue is exhausted. This lets the
real authorization and Project flow run without falling through to native UI.
Use a fresh isolated case profile when the sequence mutates state.

## Exercise Agent lifecycle behavior through fixed fake processes

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
