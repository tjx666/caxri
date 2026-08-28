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

## Relabeling a short baseline capture as passing interaction evidence

**Situation:** A blocked round captured four baseline frames and a later round
changed the case status based on supporting tests without rerunning the desktop
interaction.

**Does not work:** Encoding four 250 ms frames into a one-second MP4, or copying
that media into a passing case. A test result can support a desktop observation,
but it cannot replace the target interaction or prove its visible state change.

**Works:** Drive the real action in an owned desktop launch, capture the default
40-frame bounded sequence, inspect its start, action, transient, and settled
states, and only then cite it. Report finalization now rejects short, static,
duplicated, or previously non-passing media. See the canonical
[evidence contract](../skills/acceptance/references/evidence.md) and
[CDP recording workflow](../skills/acceptance/references/recording-cdp.md).
