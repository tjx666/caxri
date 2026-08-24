# Common Acceptance Mistakes — Caxri

This is the living log of Caxri-specific mistakes that consumed, invalidated, or
needlessly prolonged an Acceptance run. Read it before planning a desktop round.
Keep entries evidence-based and link to the canonical workflow rule instead of
duplicating the full procedure here.

## Automating native macOS dialogs during routine Acceptance

**Situation:** A product flow crosses `NSOpenPanel`, `NSSavePanel`, or another
native AppKit dialog that CDP cannot observe.

**Does not work:** Treating a general Acceptance, `$go`, or complete-real-path
request as permission to trigger and drive the dialog. Accessibility traversal
is slower and less deterministic than the existing Main-owned fixture, takes
the developer's window focus, and can turn a product check into repeated harness
debugging. Increasing timeouts or retrying the trigger does not make that evidence
reliable and can stack dialogs or repeat an action.

**Works:** Keep native dialogs as a manual boundary unless the current user
request explicitly asks the agent to verify that dialog. For automated coverage,
provide deterministic Project roots or stub Electron Main's dialog result, then
assert the Renderer, Runtime, configuration, or filesystem state on the product
side of the boundary. Never claim the native surface itself passed from stubbed
evidence. See the canonical
[native-dialog policy](../skills/acceptance/references/native-dialogs.md).
