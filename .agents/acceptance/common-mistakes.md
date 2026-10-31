# Common Acceptance Mistakes: Caxri

This is the living log of Caxri-specific mistakes that consumed, invalidated, or
needlessly prolonged an Acceptance run. Read it before planning a desktop or mobile round.
Keep entries evidence-based and link to the canonical workflow rule instead of
duplicating the full procedure here.

## Freezing fixture requirements without matching runner receipts

**Situation:** A mobile Agent case uses a synthetic CLI but never displays or samples a Terminal grid.

**Does not work:** Adding `fixturePreflight: "terminal"` just because an Agent fixture exists. The
Android runner can pass while emitting no Terminal preflight receipt, so finalization correctly
rejects the round. Likewise, an `agentFixture` plan entry needs a begin/complete lifecycle receipt
from that exact case; launching a fake Agent alone does not provide one.

**Works:** Before freezing a plan, map each declared fixture requirement to the runner's actual
receipt-producing call. Use Terminal preflight only when the case measures a rendered Terminal grid
and writes its bounded preflight receipt. Start and complete an Agent fixture lifecycle for every
case that declares `agentFixture`. Check the first case's artifact list before spending a full
batch on an unpublishable plan. See the [report contract](../skills/acceptance/references/report.md).

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

For a file-edit case, the `shell-conversation` fixture still paints synthetic Terminal rows. Use a
content-free fixture when capturing a report-bound failure screenshot; a synthetic transcript is
still Agent output under the same privacy rule.

## Guessing a mobile tab check ID from its destination

**Situation:** An Android case opens a Session's Files panel after pairing.

**Does not work:** Tapping `session-segment-files`. Files is the `caxri.files` panel's own Session
tab, `session-segment-panel-caxri.files`; the guessed ID fails before the file behavior is exercised.

**Works:** Check the mounted component's `testID` and wait for that ID in device semantics before
each navigation tap. Panel tabs appear only after the panel list loads, so wait for
`session-segment-panel-caxri.files`, open it, and only then look for `files-entry-*`.

## Reusing a disabled native button for another action

**Situation:** After saving a file, the Android framebuffer still shows the Edit action and
semantics still lists its `testID`, but the action remains `enabled=false`.

**Does not work:** Treating the visible label as proof that the action is enabled, or bypassing the
disabled state with a coordinate tap. React can reconcile a conditionally rendered Edit Pressable
with the Save Pressable that was disabled during submission.

**Works:** Give the mutually exclusive native actions distinct React keys, then use the strict
semantic tap helper to verify the returned Edit button is enabled after saving. Keep the action
away from the screen edge with a full touch target.

## Timing a whole Android gesture to capture its in-flight frame

**Situation:** An Android case must show a chip lifted mid-drag, with its neighbors stepping aside,
before the drop.

**Does not work:** Starting `input draganddrop` (or `swipe`) without awaiting it, sleeping, then
capturing. The gesture can end before the capture, so the "dragging" frame matches the dropped
state; a guard that compares it only with the pre-drag frame still passes, because a reorder also
changes the strip.

**Works:** Hold the pointer: `input motionevent DOWN`, wait past the long-press delay, send `MOVE`
steps, capture while the finger is down, then `UP`. Compare the held frame's region with both the
before and the dropped state, and look at it to confirm the item is still held.
`reorderProjectFilters` in `e2e/support/mobile-project-panels-scenarios.ts` is the reference.

## Assuming a native Android Photo Picker thumbnail has a resource ID

**Situation:** A disposable Android 36 emulator has exactly one fixture-owned JPEG in the system
Photo Picker.

**Does not work:** Querying a guessed Photo Picker thumbnail resource ID immediately after the
native source dialog. The picker opens asynchronously and its clickable image tile has no resource
ID in the device hierarchy.

**Works:** Confirm the gallery is empty before adding one synthetic image, wait for the picker to
show one enabled clickable square tile, tap its verified bounds, and confirm Caxri's attachment
state afterwards. Parse native accessibility XML only in memory and remove the temporary device dump
without uploading or logging it.

The public-frame Agent fixture intentionally ignores bracketed paste as a command, so a mobile
image send does not create a `terminalInput` receipt. Require its sanitized
`imageAttachmentReceived` receipt instead; it records only whether the referenced JPEG path is
valid and exists, never the path or message.

## Using arbitrary option labels as Android check IDs

**Situation:** A mobile Agent question renders clickable choices, but the sanitized Android semantic receipt
does not list their `testID` values.

**Does not work:** Building `testID` from an Agent-supplied label such as `Alpha`. The Android receipt
accepts only lower-case check IDs, and other labels may contain spaces or punctuation.

**Works:** Use stable numeric choice IDs and keep the Agent label in the accessibility label. Verify a
touch through the device semantics and the resulting Agent fixture receipt. See the
[Android surface procedure](../skills/acceptance/surfaces/android.md).

## Losing the desktop lease between Android cases

**Situation:** A batch reuses one release APK but launches and closes a separate isolated Electron
profile for each mobile case.

**Does not work:** Assuming the serial lock also reserves the shared macOS desktop. Another worktree
can take the desktop lease between cases, after the expensive APK build.

**Works:** Let the case's Electron launcher use the bounded active-owner lease wait, then launch only
after the repository lease is free. A stale or invalid lease still fails closed. See the
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

**Situation:** `Cmd+O` opens the Add Project flow and the "Start a Session" dialog offers
`Claude Code`, `Codex`, `Shell`, and `Empty Session`.

**Does not work:** Picking an Agent or `Shell` when the case does not need a Terminal. Acceptance
blocks Agent shims, so the Agent buttons render an executable-not-found panel, and `Shell` renders a
live prompt. Both put the machine's shell prompt, user name, and Project path into every later
screenshot of that launch: private values the round must never capture, so the artifact has to be
deleted and the case relaunched.

**Works:** Choose `Empty Session` unless the case's own claim is about the Terminal.
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

**Does not work:** Leaving that sentence in the plan. A programmatic gate is supporting evidence,
not a user outcome. Mixing it into the frozen checklist makes the plan's coverage and verdict
ambiguous and leaves publication behavior, rather than Caxri's local contract, to decide what the
reviewer sees.

**Works:** Keep the plan item strictly about the outcome a person judges, and put the supporting-test
explanation in `report.md`. Reject the plan before execution if its title, category, or method still
describes a unit test, lint gate, type-check, build, or CI result. `report.ts init` and `finalize` reject
the common English and Chinese phrasings (`report-plan-schema.ts`), but the plan gate still owns the judgment.
If an invalid round was already
published, keep it and publish the corrected round as a new one; never delete remote history.

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
afterwards, for example the launcher was killed by
something other than the adapter, run
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
from `docs/mobile/performance.md`.

## Creating an isolated Project through the E2E bridge

**Situation:** `CAXRI_E2E=1` exposes `globalThis.caxri.request` in the Renderer, and the case needs
a Project before any Session can be prepared.

**Does not work:** Calling `project.create` over the bridge with the fixture path. The launcher only
queues the test root for the real Add Project flow, so the direct call fails with `PATH_DENIED`.

**Works:** Press `Cmd+O` and choose `Empty Session`; the queued `CAXRI_TEST_ROOT_PATH`
fixture is added without a native file picker. Use the bridge afterwards for `session.create`,
`session.rename`, and `session.archive` to shape the fixture state.

In a paired mobile scenario, create every extra Session in the Project the phone was granted:
`pageRequest(page, 'session.create', { projectId: fixture.allowedProjectId, defaultAgent: 'claude' })`.
`createProjectSession` goes through `Cmd+O` and adds a new Project, so its Session never appears on
the phone and the mobile list silently shows fewer rows than the case expects.

## Reopening a flow while a dialog is still mounted

**Situation:** A Radix/Base UI dialog such as Archived Sessions is open when the next step presses a
global shortcut like `Cmd+O`.

**Does not work:** Pressing the shortcut while the dialog is mounted. The dialog swallows the key,
the Add Project flow never opens, and the following capture records the wrong state, so the
artifact must be deleted and recaptured.

**Works:** Close the dialog through its own control (`Done`), wait until the overlay is unmounted in
the DOM snapshot, then send the shortcut.

## Tapping the composer right after an Android copy

**Situation:** A case copies text on Android 13 or later, then taps the composer and pastes to prove
what reached the clipboard.

**Does not work:** Tapping the composer at once. Android's clipboard preview sits over the bottom of
the screen, so the tap lands on the preview and opens Quick Share instead of focusing the field.

**Works:** Tap a spot that does nothing in the product (the Chat timeline), wait about a second for
the preview to dismiss, then tap the composer and assert the pasted text through the sanitized
observer (`MOB-CHAT-35`).

## Tapping the video player right after a media key

**Situation:** An Android case pauses or resumes the `expo-video` player with
`adb shell input keyevent KEYCODE_MEDIA_PAUSE`, then taps the player's close button at bounds read
when the player opened.

**Does not work:** Tapping the close button at once, or concluding that the native player swallows
touches or draws the picture offset. The first tap after the media key never reached React Native;
a second identical tap closed the player. Two runs were spent on the wrong suspects before a probe
showed this.

**Works:** After the media key, tap an area of the player that only toggles its controls (above
the picture, not the center play button), wait about a second, then tap the close button
(`MOB-CHAT-VIDEO-01`, `e2e/support/mobile-agent-chat-video-scenario.ts`).
