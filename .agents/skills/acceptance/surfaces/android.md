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

For a user-owned wireless device, keep the phone's pairing screen open while completing the Mac
side. Use Android Studio's Device Manager pairing UI when computer control is available; inspect
whether that version offers a device `Pair` action or a QR flow, then verify the resulting explicit
serial with `adb devices -l`. Do not ask the user to switch apps to send a screenshot of a short-lived
pairing code. The ADB `couldn't read status message` error alone does not identify an expired code,
phone refusal, or VPN fault; recheck the live pairing service before assigning a cause or retrying.

## Current release round

For the encrypted pairing and bounded short-reply criterion, initialize the structured report first
with `surface: "mobile"`, `stateIsolation.mode: "isolated"`, and
`mobileDevice: { "appId": "com.caxri.mobile", "deviceId": "emulator-5554", "platform": "android" }`,
then run:

```bash
CAXRI_MOBILE_ACCEPTANCE_SERIAL="$SERIAL" \
CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR="$ROUND_DIR" \
CAXRI_MOBILE_ACCEPTANCE_CASE_ID="android-short-reply" \
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

## Inspect and interact without leaking content

Use Caxri's semantic helper. It first proves that Caxri owns the foreground Activity, then emits only
stable `testID` values, structural flags, and bounds:

```bash
bun run --cwd apps/mobile android:device semantics --serial "$SERIAL"
bun run --cwd apps/mobile android:device tap \
  --serial "$SERIAL" --check-id session-detail-back
```

Never upload `uiautomator dump` XML. Raw trees can contain pairing data, visible text, Session names,
Terminal output, and accessibility descriptions. Prefer semantic identifiers over coordinates; use
coordinates only after a sanitized inspection proves one unambiguous target.
When an Acceptance UiAutomator helper invokes `adb shell`, omit option pairs whose value is empty:
ADB drops empty positional arguments. Keep failures attributable to a safe execution stage and a
closed reason code; never print raw stdout, command arguments, or fixture text into reports.
Before diagnosing a missing `testID`, verify the expected screen with a stable route marker. Start
swipes inside the content area, away from Android's Back gesture edges, and check the route again.

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
