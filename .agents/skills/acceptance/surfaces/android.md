# Android surface

Use this surface for native Android layout, navigation, touch, pairing, reconnection, short replies,
camera permission, or device-performance claims. The canonical report surface is `mobile`.

## Target and ownership

Resolve one explicit ADB serial and keep it for the whole case. The automated release round accepts
only a disposable `emulator-<number>` target. A Wi-Fi or USB physical device is user-owned: the user
must unlock it and approve debugging, and Acceptance must not clear its package data, uninstall the
app, change system settings, reboot it, or stop it.

```bash
SERIAL=emulator-5554
bun run --cwd apps/mobile android:device inspect --serial "$SERIAL"
```

Do not use the first result from `adb devices`, Expo's implicit selection, or an Android model name
as the ADB identity. Keep the exact serial in every command.
An explicit serial selects a device but does not reserve it. Parallel tasks must use distinct
disposable emulator instances; the Desktop lease does not serialize APK installs, package clears,
or native taps. Launch a task-owned AVD with an unused port when the shared instance is active;
copy only hardware configuration and use fresh user data, never another task's live disk image.
Detach the launch from the agent's shell, or the emulator dies with that shell and the next case
fails with `device 'emulator-N' not found`. On macOS (no `setsid`):

```bash
nohup ~/Library/Android/sdk/emulator/emulator -avd <avd> -port <unused even port> -read-only \
  -wipe-data -no-snapshot -no-audio -no-window >/tmp/emu-<port>.log 2>&1 & disown
```

`-read-only` lets the task share an AVD that another instance is using. Stop it with
`adb -s emulator-<port> emu kill` and confirm it left `adb devices`.
Freeze that serial in the new report round and stop only the
instance this task launched. If Android reports `PACKAGE UPDATED` during a case, investigate
another installer before attributing the interruption to an app crash.

The guarded release runner holds a repository-wide lock for that emulator serial from build and
installation through fixture IME restoration and device cleanup. If another worktree owns the
serial, wait for its run to finish before starting another round. Do not select the fixture IME or
clear the package outside the serial lock while another Acceptance run is active.
An isolated mobile case waits up to three minutes for another worktree's active desktop lease after
the APK build. The lease remains fail-closed for stale or invalid ownership; never stop the sibling
desktop instance to unblock a round.

For a user-owned wireless device, keep the phone's pairing screen open while completing the Mac
side. Use Android Studio's Device Manager pairing UI when computer control is available; inspect
whether that version offers a device `Pair` action or a QR flow, then verify the resulting explicit
serial with `adb devices -l`. Do not ask the user to switch apps to send a screenshot of a short-lived
pairing code. The ADB `couldn't read status message` error alone does not identify an expired code,
phone refusal, or VPN fault; recheck the live pairing service before assigning a cause or retrying.

## Current release round

For the encrypted pairing and main phone journey (`MOB-E2E-01`), initialize the structured report first
with `surface: "mobile"`, `stateIsolation.mode: "isolated"`, and
`mobileDevice: { "appId": "com.caxri.mobile", "deviceId": "emulator-5554", "platform": "android" }`,
then run:

```bash
CAXRI_MOBILE_ACCEPTANCE_SERIAL="$SERIAL" \
CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR="$ROUND_DIR" \
CAXRI_MOBILE_ACCEPTANCE_CASE_ID="MOB-E2E-01" \
  bun run test:e2e:mobile:android
```

The guarded runner first requires a clean source tree at the frozen report commit, then builds
Desktop artifacts, regenerates Android native sources, creates and installs a release APK, verifies
the non-debuggable package, clears only `com.caxri.mobile` before
and after the case, launches an isolated Desktop/Server fixture, pairs through the encrypted gateway,
and sends one fixed bounded reply. Stage and overall deadlines bound every child command. It never
uses ambient Metro or a stale APK. Include all generated
files in the case evidence:

- `assets/<case-id>-state-isolation.json`
- `assets/<case-id>-mobile-device.json`
- `assets/<case-id>-result.json`
- `assets/<case-id>-android.png`
- `assets/<case-id>-android.mp4`

The receipts contain the report source commit, final lifecycle launch id, build hash, explicit
emulator identity, cleanup state, observed user outcome, and the framebuffer artifact paths and
SHA-256 values. A clean retry replaces prior receipts atomically; report finalization rejects stale
launch, commit, device, source, or artifact identities. They exclude the
pairing link, QR payload, reply text, Session identity, Terminal
content, Project path, source, logs, and environment values. The runner writes this receipt from its
cleanup path for `passed`, `failed`, and pre-launch `blocked` outcomes so a failed round can still be
finalized honestly.

### Per-case motion and app language

A case definition in `scripts/mobile-android-cases.ts` may declare `motion: 'live'` to turn the round's reduced
motion off for that case alone, so a recording shows real animation (the shimmer case does). It may declare
`appLocale: 'zh-CN'` to render the app in Chinese: the runner sets Android 13+'s per-app language with
`cmd locale set-app-locales com.caxri.mobile --locales zh-CN`, reads it back with `get-app-locales`, and clears it in
cleanup before the package data reset (`scripts/mobile-acceptance-locale.ts`). Changing the emulator's system locale
needs root and a framework restart, so it is not used. Both options accept only a disposable `emulator-N` serial.

## Inspect and interact without leaking content

Use public synthetic Project paths for recordings. Approval cards display their real working
directory, so the native fixture uses `/tmp` on macOS instead of its account-specific system temp
directory. Keep any earlier frames that expose the system temp path private and recapture them.

Use Caxri's semantic helper. It first proves that Caxri owns the foreground Activity, then emits only
stable `testID` values, structural flags, and bounds:

```bash
bun run --cwd apps/mobile android:device semantics --serial "$SERIAL"
bun run --cwd apps/mobile android:device tap \
  --serial "$SERIAL" --check-id session-detail-back
```

The receipt keeps only the first node per `testID`, so it cannot count repeated controls: two Copy
buttons sharing `agent-chat-work-copy` read as one. Give each instance its own `testID` when a
scenario must find or count it.

Never upload `uiautomator dump` XML. Raw trees can contain pairing data, visible text, Session names,
Terminal output, and accessibility descriptions. Prefer semantic identifiers over coordinates; use
coordinates only after a sanitized inspection proves one unambiguous target.
`uiautomator dump` waits for an idle screen and, when none comes, exits 0 without writing its file,
so the helper fails as `driver-failed`. A running Chat turn never idles even under reduced motion:
the activity line's elapsed time and native spinner keep changing. Read semantics before the turn
starts or after it ends (or while it waits on the user), and follow a running turn with
`mobileRegionFingerprint` and framebuffer captures instead (`MOB-CHAT-13` measures the slot with
a short turn first). `android:device observe` and `observeMobileNode` use the same idle-dependent dump;
they are sanitized observations, not an immediate bypass. To press Stop during a live reply, capture
the composer action's bounds while idle, verify Stop's theme color there with `mobileColorBounds`,
and tap the current color bounds. A running background task's sheet and detail redraw their elapsed time every second, so they
never idle either: `MOB-CHAT-16` finds Stop there by its theme color with `mobileColorBounds`, re-reads it until two
reads agree (the sheet grows as output arrives), and reads semantics again once the task has stopped.
On Android 36, deprecated `uiautomator runtest` can abort before executing a test and still print
`OK (1 test)`; the observed abort was `android.test.RepetitiveTest` resolution failure. Never
treat that line or a zero ADB exit status as a native assertion. Use the foreground-checked
`android:device observe` command for focus and private text predicates, and prove a missing target
on a screen without that control before trusting a new assertion path. React Native exposes `testID`
as an Android resource ID; `UiSelector.description` queries `contentDescription`
([Android API](<https://developer.android.com/reference/androidx/test/uiautomator/UiSelector#description(java.lang.String)>)).
Keep failures attributable to a safe execution stage and a closed reason code; never print raw
stdout, command arguments, fixture text, or accessibility XML into reports.
For multiline Unicode in a controlled React Native input, use the Acceptance fixture IME's
`InputConnection.commitText` path in `e2e/support/mobile-unicode-input.ts`. Focus the resource ID,
check exact native text through the sanitized observer, then require the React-visible action state
and resulting product effect. The runner must accept an explicit disposable emulator serial, select
the fixture IME only after saving the previous default, and restore that default, disable the fixture,
and uninstall it in cleanup after every outcome. Never select the fixture IME on a real phone; a
native-only draft remains an execution failure. When leftover fixture IME state (a stale fixture
package or an unusable default input method) blocks startup, recover with the task-owned emulator's
clean-start launch above (`-wipe-data`); do not add another cleanup path.
After installing the fixture, discover it with `ime list -a -s`: plain `ime list -s` lists enabled
methods only, so it hides the newly installed fixture until `ime enable` runs.
The fixture IME draws no keyboard, yet `dumpsys input_method` still reports `mInputShown=true` while
a field is focused, and the IME does not consume Back. While it is selected, never send Back to
close a keyboard: the key reaches the app and leaves the screen (`hideChatKeyboard` checks
`default_input_method` first).
Because nothing is drawn, a claim about layout beside the keyboard passes with the whole screen free:
run that step inside `withVisibleKeyboard` (`e2e/support/mobile-agent-chat-helpers.ts`), which
selects the emulator's own keyboard for the step, and judge the capture with the keyboard visibly
occupying the screen.
Before diagnosing a missing `testID`, verify the expected screen with a stable route marker. Start
swipes inside the content area, away from Android's Back gesture edges, and check the route again.
An identifier existing in source does not prove that the current Agent, device role, and segment
render it. Choose a visible composer entry before entering text. During a mobile Terminal lease,
Desktop's rendered grid follows the phone; verify window geometry separately, and expect the
Desktop grid to return only after release. Control devices take the lease automatically when the
Terminal opens; Release keeps it released until the reader leaves the Terminal, so tap it before
asserting observing behavior. For pinch claims, inject one native two-pointer gesture
and inspect the resulting framebuffer; parallel single-pointer swipes do not establish pinch behavior.
Keep injected render failures active until the error screen's explicit retry action clears them;
a one-shot mutation during render can be consumed by React's automatic replay without showing the boundary.
A selectable `<Text>` is not clickable, so the `tap` helper's long press refuses it. Read its
bounds from fresh semantics and long-press inside them with a same-point `input swipe x y x y 900`,
then judge the selection from a screenshot (`MOB-CHAT-35`).
For metadata cases such as Session title updates, select Project before capturing the detail page.
A fallback shell may display the host account and machine name even inside an isolated Project;
Terminal evidence requires a synthetic shell or Agent fixture instead.

## Capture and judge

Capture device pixels, not a crop of the Android Studio emulator window:

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" -s "$SERIAL" exec-out screencap -p > "$ROUND_DIR/assets/android-state.png"
```

The guarded release runner performs this capture itself and records the exact path and SHA-256 in
the mobile device receipt. For a separately driven case, add the same device-bound artifact entry
before finalization; a file extension alone is never accepted as Android evidence.

Read the full-resolution screenshot before citing it. Check safe areas, system bars, clipping,
overlap, keyboard coverage, selection state, target identity, and phone/tablet layout. Pair a touch
command with a fresh semantic postcondition; a final screenshot alone does not prove which input
caused it. Follow [the Android recording guide](../references/recording-android.md) when the criterion
depends on a transition or multi-step flow.

An emulator can prove the functional path but not camera optics, haptics, thermal behavior, radio
quality, battery use, or physical-device release performance. Plan those separately on a named real
device and do not convert emulator results into a pass.
