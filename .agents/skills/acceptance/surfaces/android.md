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

The guarded runner builds current Desktop artifacts, regenerates Android native sources, creates and
installs a release APK, verifies the non-debuggable package, clears only `com.caxri.mobile` before
and after the case, launches an isolated Desktop/Server fixture, pairs through the encrypted gateway,
and sends one fixed bounded reply. It never uses ambient Metro or a stale APK. Include both generated
files in the case evidence:

- `assets/<case-id>-state-isolation.json`
- `assets/<case-id>-mobile-device.json`

The result receipt contains build hash, explicit emulator identity, cleanup state, and the observed
user outcome. It excludes the pairing link, QR payload, reply text, Session identity, Terminal
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

## Capture and judge

Capture device pixels, not a crop of the Android Studio emulator window:

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" -s "$SERIAL" exec-out screencap -p > "$ROUND_DIR/assets/android-state.png"
```

Read the full-resolution screenshot before citing it. Check safe areas, system bars, clipping,
overlap, keyboard coverage, selection state, target identity, and phone/tablet layout. Pair a touch
command with a fresh semantic postcondition; a final screenshot alone does not prove which input
caused it. Follow [the Android recording guide](../references/recording-android.md) when the criterion
depends on a transition or multi-step flow.

An emulator can prove the functional path but not camera optics, haptics, thermal behavior, radio
quality, battery use, or physical-device release performance. Plan those separately on a named real
device and do not convert emulator results into a pass.
