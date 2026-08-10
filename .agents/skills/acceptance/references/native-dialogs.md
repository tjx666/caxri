# Native macOS dialogs

CDP and Playwright observe the Electron Renderer, not an `NSAlert` owned by
macOS. The alert may be a sheet attached to a Caxri window or an app-modal
window when `dialog.showMessageBox` has no parent. Handle both at the narrowest
layer that proves the claim.

## Focused regression tests

Stub `dialog.showMessageBox` through Playwright's Main-process evaluation and
return the intended response. This is the deterministic pattern already used by
Caxri's focused Electron E2E specs. Assert the resulting product state in the
Renderer, Runtime, or filesystem; do not try to automate macOS UI in a routine
regression test.

## Real Acceptance

When the native dialog itself or the complete real user path must be verified:

1. Trigger the action once through the Renderer.
2. Inspect the owned isolated app for exactly one sheet or app-modal window
   containing the semantic button name:

   ```bash
   bun run .agents/skills/acceptance/scripts/native-dialog.ts inspect \
     --button "Move to Trash"
   ```

3. Capture the smallest macOS-level screenshot only when the plan requires
   visual proof of the sheet. Ensure it contains no unrelated desktop content.
4. Click the button by its Accessibility name:

   ```bash
   bun run .agents/skills/acceptance/scripts/native-dialog.ts click \
     --button "Move to Trash"
   ```

5. Return to CDP and verify the resulting Renderer and filesystem state.

The helper validates `.records/acceptance/runtime.json`, queries the owned
Electron process tree once per attempt, recursively resolves nested native
buttons, rejects multiple matching dialogs, and never uses screen coordinates.
Every Accessibility query has a hard timeout. macOS must grant Accessibility
permission to the terminal process running the helper; missing permission fails
with a direct remediation message instead of hanging.

## Failure rules

- Never re-trigger a menu command while waiting for its dialog; stacked dialogs
  make both evidence and interaction ambiguous.
- Never use coordinate clicks. Window movement, scaling, and a negative desktop
  origin make them unreliable.
- Do not replace a real Acceptance path with a stub. The stub belongs only to
  focused deterministic regression coverage.
- Do not use host-screen video for Renderer behavior. Native window capture can
  expose unrelated windows, while Terminal GPU content can record as black.
