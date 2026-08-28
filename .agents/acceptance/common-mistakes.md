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

## Interacting before a closing dialog overlay unmounts

**Situation:** A dialog action creates the expected product state, and the next target is already visible behind the
closing dialog.

**Does not work:** Interacting as soon as the target appears, or adding a fixed sleep after the dialog action. Base UI
keeps the exit backdrop mounted until its animation finishes, so the visible target can still be covered; a fixed delay
only hides the missing stop condition and varies across motion settings and machines.

**Works:** Wait until both `[data-slot="dialog-content"]` and `[data-slot="dialog-overlay"]` are absent, together with
the target product state being present, before the next interaction. This mirrors the product's actual interaction
boundary and avoids timing guesses.

## Pinning a tab on Electron's raw CDP endpoint

**Situation:** An Acceptance command connects `agent-browser` directly to the
owned Electron CDP port.

**Does not work:** Passing `--pin-tab`. The option calls `Target.createTarget`,
which Electron's raw CDP endpoint does not support, so the command fails before
it can inspect the existing Renderer.

**Works:** Give the round a unique `--session`, pass `--no-pin-tab`, and repeat
the owned `--cdp` port on every command. See the canonical
[agent-browser workflow](../skills/acceptance/references/agent-browser.md).

## Passing an Acceptance screenshot path positionally

**Situation:** A settled screenshot must be written beneath the round's
`assets/` directory.

**Does not work:** Calling `agent-browser screenshot <path>`. The command's
positional shape accepts both selector and path, so a single path can be parsed
as a selector and leave no usable evidence.

**Works:** Call `capture-renderer.ts screenshot --output <path>`. The explicit
option removes the ambiguity and the helper verifies the owned Acceptance
runtime and Renderer target. See the canonical
[agent-browser workflow](../skills/acceptance/references/agent-browser.md).

## Advancing an Acceptance round through the status command

**Situation:** The Go ledger needs to record that desktop Acceptance is running
or pending.

**Does not work:** Adding `--round` to `state.ts acceptance`. A round number is
publication lineage, not ordinary status, and advancing it early makes the
ledger disagree with the immutable remote history.

**Works:** Record status without a round. Let `state.ts acceptance-publish`
advance the round only after exact remote readback; reserve
`acceptance-reconcile-round` for an explicitly documented ledger repair. See the
canonical [Go Acceptance loop](../skills/go/references/acceptance-loop.md).
