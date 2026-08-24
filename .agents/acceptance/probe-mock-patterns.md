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

Existing examples include `src/main/__tests__/workbench-root-authority.test.ts`,
`src/main/__tests__/main-methods-dialogs.test.ts`, and the focused Electron specs
that set `CAXRI_TEST_ROOT_PATHS`.

## Queue deterministic Project choices without a picker

**Situation:** One Acceptance case must add or switch between multiple Projects.

**Works:** Repeat `--test-root PATH` in the intended selection order. The launcher
serializes the paths into `CAXRI_TEST_ROOT_PATHS`; Main consumes one path per
request and retains the final root after the queue is exhausted. This lets the
real authorization and Project flow run without falling through to native UI.
Use a fresh isolated case profile when the sequence mutates state.
