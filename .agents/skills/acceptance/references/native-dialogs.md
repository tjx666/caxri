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

1. Compile/warm the helper cache and fail fast on permission, ownership, AX
   readiness, or a locked desktop before consuming the case trigger:

   ```bash
   bun run .agents/skills/acceptance/scripts/native-dialog.ts preflight
   ```

2. Trigger the action once through the Renderer.
3. Inspect the owned isolated app for exactly one sheet or app-modal window
   containing the semantic button name:

   ```bash
   bun run .agents/skills/acceptance/scripts/native-dialog.ts inspect \
     --button "Move to Trash"
   ```

4. Capture the smallest macOS-level screenshot only when the plan requires
   visual proof of the sheet. Ensure it contains no unrelated desktop content.
5. Click the button by its Accessibility name:

   ```bash
   bun run .agents/skills/acceptance/scripts/native-dialog.ts click \
     --button "Move to Trash"
   ```

6. Return to CDP and verify the resulting Renderer and filesystem state.

For an `NSOpenPanel`, AppKit may render the chooser through
`com.apple.appkit.xpc.openAndSavePanelService`, but its semantic Accessibility
nodes remain attached beneath the owned Electron application's `AXChildren`
tree. Use the dedicated helper; never query or guess the service PID:

```bash
bun run .agents/skills/acceptance/scripts/open-panel.ts inspect \
  --title "Import Theme" --button "Open"
bun run .agents/skills/acceptance/scripts/open-panel.ts choose-path \
  --title "Import Theme" --button "Open" \
  --path test-results/acceptance-native/fixture.json
bun run .agents/skills/acceptance/scripts/open-panel.ts inspect \
  --title "Import Theme" --button "Open"
bun run .agents/skills/acceptance/scripts/open-panel.ts click \
  --title "Import Theme" --button "Open"
```

`choose-path` accepts only a real, non-hidden file inside the current
Acceptance worktree. The helper selects the deepest provable sidebar ancestor,
walks exact absolute `AXURL` values through the chooser's file browser, and
leaves the final `Open` action to the exact `AXDefaultButton`. Stage chooser
fixtures under the gitignored `test-results/acceptance-native/` directory;
`.records/` is hidden from the normal chooser and is reserved for evidence.
Never substitute an XPC PID, a title-only match, a keyboard shortcut, or a
coordinate click.

Do not use a real folder chooser to bootstrap a Project for an unrelated case.
`start-electron.ts` supplies the selected Project through `CAXRI_TEST_ROOT_PATH`
by default, exercising the existing Main-owned authorization fixture without an
`NSOpenPanel`. Pass `--native-dialog` only when the chooser is itself named by
the Acceptance requirement. Electron implements a parented file chooser as an
AppKit sheet, while modern macOS hosts its content through
`com.apple.appkit.xpc.openAndSavePanelService`; treating that remote UI as setup
adds timing and Accessibility ownership that the product behavior under test
does not need.

Both helpers validate `.records/acceptance/runtime.json`, query only the owned
Electron Main PID, and call ApplicationServices directly through the repository
Swift helper. Ordinary dialogs check `AXDefaultButton` and `AXCancelButton`
first, then use a depth- and element-bounded traversal that never enters file
browser content roles. Open panels require one `AXSheet` with
`AXIdentifier=open-panel`, the exact product title, and one
`AXDefaultButton`/`OKButton`. Both reject incomplete or multiple matches and
never use AppleScript, screen coordinates, global keyboard events, or
frontmost-app guessing.

The wrapper compiles the single Swift source once per source/toolchain/platform
hash into `~/.cache/caxri/acceptance/native-ax/`; later invocations reuse the
binary across worktrees. The native process applies a finite AX messaging
timeout and returns one structured JSON response that distinguishes permission,
target-lifecycle, traversal, ambiguity, timeout, selection, and action failures.
An `AXPress` is issued at most once. If AppKit reports `cannotComplete`, treat
the action as uncertain, inspect product state, and never retry it blindly.

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
- Stop before the native trigger when `NSWorkspace` reports `loginwindow` as
  frontmost or host screenshots are black. A locked macOS session can launch an
  AppKit service without creating an interactive chooser, so this is an
  environment block rather than a product failure.
- Never use coordinate clicks. Window movement, scaling, and a negative desktop
  origin make them unreliable.
- Do not replace a real Acceptance path with a stub. The stub belongs only to
  focused deterministic regression coverage.
- Do not use host-screen video for Renderer behavior. Native window capture can
  expose unrelated windows, while Terminal GPU content can record as black.
