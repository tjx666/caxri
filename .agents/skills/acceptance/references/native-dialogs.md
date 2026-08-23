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

Do not use a real folder chooser to bootstrap a Project for an unrelated case.
`start-electron.ts` supplies the selected Project through `CAXRI_TEST_ROOT_PATH`
by default, exercising the existing Main-owned authorization fixture without an
`NSOpenPanel`. Pass `--native-dialog` only when the chooser is itself named by
the Acceptance requirement. Electron implements a parented file chooser as an
AppKit sheet, while modern macOS hosts its content through
`com.apple.appkit.xpc.openAndSavePanelService`; treating that remote UI as setup
adds timing and Accessibility ownership that the product behavior under test
does not need.

The helper validates `.records/acceptance/runtime.json`, queries only the owned
Electron Main PID, checks `AXDefaultButton` and `AXCancelButton` first, and falls
back to a depth- and element-bounded direct-child traversal that never enters
file-browser content roles. It rejects incomplete or multiple matches and never
uses screen coordinates. `inspect` remains read-only; only an exact `click`
match may bring the isolated app to the front.

The Acceptance launcher clones Electron beneath the profile's `apps.noindex/`
root with a unique temporary bundle identity and starts that clone through
LaunchServices. It deliberately keeps the main
executable named `Electron`, preserving `app.isPackaged === false` and the normal
unpackaged build paths while making the PID-owned Accessibility query distinct
from a concurrently running Caxri dev app. Treat any regression to a shared
`com.github.Electron` identity as a harness defect; never work around it by
stopping the developer's app.
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
