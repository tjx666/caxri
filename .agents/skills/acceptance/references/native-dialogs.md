# Native macOS dialogs

CDP and Playwright observe the Electron Renderer, not an `NSAlert`, `NSOpenPanel`, or `NSSavePanel`
owned by macOS. Agent-driven native dialog interaction is therefore a manual Acceptance boundary by
default.

## Default policy: hand native UI to the user

An agent must not trigger, inspect, select within, click, record, or retry a native macOS dialog.
This applies to routine regression tests, visual Acceptance, `$go`, broad "test everything" requests,
and complete-real-path wording. None of those requests authorizes taking the user's focus or driving
system UI.

When a product flow crosses a native dialog:

1. Verify the behavior before and after the dialog through deterministic Main fixtures or stubs.
2. If the dialog itself changed, give the user a short manual checklist covering the exact trigger,
   expected title/options, cancel behavior, confirm behavior, and resulting product state.
3. Never claim that the native surface passed from stubbed evidence. Record the manual boundary or
   wait for the user's result.
4. If a native dialog appears unexpectedly, stop the owned Acceptance launch immediately. Do not
   tune Accessibility timeouts, repair the adapter, or retry the trigger inside the feature delivery.

## Deterministic automated coverage

Stub `dialog.showMessageBox`, `dialog.showOpenDialog`, or `dialog.showSaveDialog` through
Playwright's Main-process evaluation and return the intended response. Assert the resulting product
state in the Renderer, Runtime, configuration, or filesystem. This is the fast, deterministic
pattern already used by Caxri's focused Electron E2E specs.

Use `CAXRI_TEST_ROOT_PATH` / `CAXRI_TEST_ROOT_PATHS` for Project selection. The Acceptance launcher
supplies these by default, so setup never falls through to a folder chooser. For file import/export,
stage a fixture and stub the Main dialog result to that exact path; exercise validation, error
feedback, atomicity, and persistence after the boundary without automating the macOS window.

## Explicit user-request exception

Only a current user request that explicitly asks the agent to verify a native dialog authorizes the
exception below. A general Acceptance request does not. Record that authorization in the local
Acceptance evidence before launch, pre-author one interaction and its cleanup, and prefix every
native command with the fail-closed marker. Do not export it into a persistent shell.

For a folder chooser, pass `--native-dialog` to `start-electron.ts`; otherwise retain the deterministic
test-root fixture and trigger the specifically requested dialog once. Warm and validate Accessibility
before consuming the trigger:

```bash
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/native-dialog.ts preflight
```

An ordinary alert uses its exact semantic button:

```bash
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/native-dialog.ts inspect --button "Move to Trash"
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/native-dialog.ts click --button "Move to Trash"
```

An open panel uses its exact product title, semantic `Open` action, and a real non-hidden fixture
inside the current Acceptance worktree. For **Import Theme**, the frozen plan must declare
`"themeImportFixture": false` and `start-electron.ts` must run under the same marker; otherwise Main
rejects the import instead of opening the panel:

```bash
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/open-panel.ts inspect \
  --title "Import Theme" --button "Open"
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/open-panel.ts choose-path \
  --title "Import Theme" --button "Open" \
  --path test-results/acceptance-native/fixture.json
CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request \
  bun run .agents/skills/acceptance/scripts/open-panel.ts click \
  --title "Import Theme" --button "Open"
```

The helpers and launcher refuse these paths unless the exact authorization marker is present. They
query only the owned Electron Main PID, require exact semantic matches, bound every AX call, and issue
`AXPress` at most once. Never use screen coordinates, global keyboard events, an XPC service PID,
frontmost-app guessing, or a second trigger. On the first unexpected result, close the owned UI, stop
the launch, and return the remaining check to the user instead of repairing or retrying the native
adapter.
