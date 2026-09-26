# Common Acceptance Mistakes — Caxri

This is the living log of Caxri-specific mistakes that consumed, invalidated, or
needlessly prolonged an Acceptance run. Read it before planning a desktop or mobile round.
Keep entries evidence-based and link to the canonical workflow rule instead of
duplicating the full procedure here.

## Capturing mobile Agent fixture content in public evidence

**Situation:** An Android Acceptance case displays a synthetic Agent request over its Session conversation.

**Does not work:** Assuming synthetic Session titles and transcripts are safe to publish, or passing a
privacy switch through `sourceEnvironment`. The fake Agent isolation builder selects its own environment
keys, so that switch does not reach the executable. A successful device case can still have unusable media.

**Works:** Select the fixture's `isPublicFrame` source variant before generating its executable, then inspect
the full screenshot and recording before citing them. The variant emits no transcript content or Terminal
output and uses a generic Session label. A missing transcript routes the app to Terminal, so a pending native
Agent request must remain reachable there. An empty fixture-owned transcript file can make Conversation and
its composer available without visible conversation content. Follow the
[Acceptance privacy rule](../skills/acceptance/SKILL.md).

## Using arbitrary option labels as Android check IDs

**Situation:** A mobile Agent question renders clickable choices, but the sanitized Android semantic receipt
does not list their `testID` values.

**Does not work:** Building `testID` from an Agent-supplied label such as `Alpha`. The Android receipt
accepts only lower-case check IDs, and other labels may contain spaces or punctuation.

**Works:** Use stable numeric choice IDs and keep the Agent label in the accessibility label. Verify a
touch through the device semantics and the resulting Agent fixture receipt. See the
[Android surface procedure](../skills/acceptance/surfaces/android.md).

## Comparing an isolated Desktop profile by its original temporary path

**Situation:** An Acceptance helper binds Desktop media to the isolated Electron profile.

**Does not work:** Hashing or comparing the temporary path supplied to the launcher. macOS can
resolve `/var` to `/private/var`, and Electron installs the canonical path as `userData`.

**Works:** Resolve the profile's real path before recording its identity, and compare it with
Electron's `userData` path. Keep the original fixture path for owned cleanup. See the
[Desktop evidence contract](../skills/acceptance/references/report.md).

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

## Reaching the owned Electron endpoint with `agent-browser connect`

**Situation:** A round needs `agent-browser` attached to the CDP port the Acceptance launcher already
owns.

**Does not work:** `agent-browser --session <name> connect <port>`. Despite the verb, it launches a
fresh Chromium and leaves the session pointed at `about:blank`, so every later command inspects an
empty page instead of the Caxri Renderer, and the stray browser has to be cleaned up.

**Works:** `--cdp <port>` is the attach flag. Repeat
`agent-browser --cdp <port> --session <name> --no-pin-tab` on every command. In zsh, keep that prefix
in an array (`AB=(agent-browser --cdp 9222 ...)` then `"${AB[@]}" press ...`); an unquoted scalar is
not word-split and fails with `command not found`. See the canonical
[agent-browser workflow](../skills/acceptance/references/agent-browser.md).

## Choosing an Agent Terminal while bootstrapping an isolated Project

**Situation:** `Cmd+O` opens the Add Project flow and the "Choose the default Terminal" dialog offers
`Claude Code`, `Codex`, `Shell`, and `Start without a Terminal`.

**Does not work:** Picking an Agent or `Shell` when the case does not need a Terminal. Acceptance
blocks Agent shims, so the Agent buttons render an executable-not-found panel, and `Shell` renders a
live prompt. Both put the machine's shell prompt, user name, and Project path into every later
screenshot of that launch — private values the round must never capture, so the artifact has to be
deleted and the case relaunched.

**Works:** Choose `Start without a Terminal` unless the case's own claim is about the Terminal.
Declare `agentFixture` in the frozen plan when fake Agent processes are genuinely required. Also
snapshot before focusing any dialog `@ref`: ref numbering is assigned per launch, so a ref memorized
from an earlier launch silently activates a different button.

## Sending fixed Agent input after its Terminal view detached

**Situation:** A fixture command must start or finish a real Agent turn while the evidence excludes Terminal output.

**Does not work:** Hiding or replacing the Terminal pane before calling `terminal.input`, then treating an
`{ok:true,result:null}` response as proof that the PTY received the bytes. An inactive Terminal view detaches its
attachment, and the request result alone does not prove delivery.

**Works:** Send the fixed command while the exact Agent Terminal is visibly attached, then verify a hook or metadata
increment. Capture only the Session row when Terminal output must remain private, and switch back to the attached
Terminal before an input action such as Escape.

## Deferring every boundary receipt until cleanup

**Situation:** One Acceptance case exercises several lifecycle boundaries before stopping an owned runtime.

**Does not work:** Keep every result in memory and write one aggregate receipt from a `finally` block. A later assertion
or stop failure can overwrite the primary error and erase which earlier boundaries completed.

**Works:** Write one exclusive, content-free checkpoint immediately after each boundary. Freeze the primary stage,
error class, and closed reason before cleanup, then record cleanup status and reason separately; cleanup errors must not
replace the scenario result.

## Naming a repository test suite in a frozen Acceptance plan item

**Situation:** A plan item's `method` or `category` explains that some part of the contract is
carried by a unit test, a lint gate, or a type-check.

**Does not work:** Leaving that sentence in the plan. LobeHub's ingest screens every plan item's
title, category, and method for programmatic-test vocabulary — including the Chinese 单测 /
单元测试 / 类型检查 — and silently drops the entire matching check from the round. The published
round then carries one fewer check and its verdict is recomputed upward, so a locally blocked case
can surface remotely as a clean pass. Go's publication readback fails closed on the mismatch, and the
already-ingested round is immutable.

**Works:** Keep the plan item strictly about the outcome a person judges, and put the supporting-test
explanation in `report.md`, which is not screened. If a round was already published with a dropped
check, retain it with `state.ts acceptance-orphan` and republish the corrected round; never delete
remote history. See the canonical
[Go Acceptance loop](../skills/go/references/acceptance-loop.md).

## Recovering a case whose launcher never completed its receipt

**Situation:** `report.ts finalize` rejects a round with
`Case <id> state-isolation receipt does not match the frozen plan`, and `start-electron.ts` refuses
the same case with `Previous Acceptance case launch has not completed`. The launch entry in
`assets/<case-id>-state-isolation.json` still has `completedAt: null`.

**Does not work:** Deleting or editing the receipt by hand. That rewrites the evidence chain the
report is supposed to prove.

**Works:** Stop the instance through `stop-electron.ts` first. The adapter lets the launcher finish
its own teardown, escalates only after a long quiet period or once three grace periods have
elapsed regardless of progress, and completes the receipt itself when the launcher could not; a
launch closed this way carries `forcedCompletion` naming the source and reason. When the launcher
completed its receipt while a detached Server generation still held the profile, the adapter's later
profile removal is recorded as `deferredCleanup` on the same launch. If the receipt is still pending
afterwards — for example the launcher was killed by
something other than the adapter — run
`bun run .agents/skills/acceptance/scripts/report.ts repair-lifecycle --dir <round> --case-id <id> --reason "<why>"`.
It closes the pending launch with the reason on record and, for an isolated case, only after
verifying the profile directory is gone. See [#611](https://github.com/tjx666/caxri/issues/611).

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

## Treating a development client or stale native install as current mobile evidence

**Situation:** A mobile screen is already visible on an emulator or Simulator after source,
configuration, or native plugin changes.

**Does not work:** Capturing the existing app and inferring that it represents the current working
tree. Metro can update JavaScript while leaving stale native code installed, and generated Expo
projects can survive config changes.

**Works:** Record the exact device, regenerate the applicable native project when configuration or
plugins changed, build the current native binary, install it explicitly, and preserve build identity.
For the Android cross-device path, use `bun run test:e2e:mobile:android` with report directory and
case id so the guarded runner produces lifecycle and APK-hash receipts.

## Uploading raw mobile accessibility output

**Situation:** A tap target or postcondition must be inspected on Android or iOS.

**Does not work:** Attaching a raw UIAutomator XML dump or unreviewed Accessibility hierarchy. It can
contain a pairing credential, visible Terminal content, Session names, Project paths, keyboard
suggestions, or other private text.

**Works:** On Android, use `android:device semantics`, which emits only stable identifiers and
structural flags and deletes the raw dump. On iOS, review the hierarchy before attaching it and omit
it when it contains private values. In both cases, capture a fresh isolated artifact if a pairing QR
or link entered any frame.

## Using an emulator measurement as a release-performance pass

**Situation:** Emulator or Simulator launch and frame measurements are available.

**Does not work:** Comparing those values directly with physical-device release budgets. Host load,
virtualization, development shells, and UI-tree polling dominate several measurements.

**Works:** Use virtual-device measurements as diagnostics only. A release-performance acceptance
case names one physical device, current release build, sampling method, repetition count, and budget
from `docs/mobile/PERFORMANCE.md`.

## Creating an isolated Project through the E2E bridge

**Situation:** `CAXRI_E2E=1` exposes `globalThis.caxri.request` in the Renderer, and the case needs
a Project before any Session can be prepared.

**Does not work:** Calling `project.create` over the bridge with the fixture path. The launcher only
queues the test root for the real Add Project flow, so the direct call fails with `PATH_DENIED`.

**Works:** Press `Cmd+O` and choose `Start without a Terminal`; the queued `CAXRI_TEST_ROOT_PATH`
fixture is added without a native file picker. Use the bridge afterwards for `session.create`,
`session.rename`, and `session.archive` to shape the fixture state.

## Reopening a flow while a dialog is still mounted

**Situation:** A Radix/Base UI dialog such as Archived Sessions is open when the next step presses a
global shortcut like `Cmd+O`.

**Does not work:** Pressing the shortcut while the dialog is mounted. The dialog swallows the key,
the Add Project flow never opens, and the following capture records the wrong state, so the
artifact must be deleted and recaptured.

**Works:** Close the dialog through its own control (`Done`), wait until the overlay is unmounted in
the DOM snapshot, then send the shortcut.
