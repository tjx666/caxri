# Caxri mobile runtime field notes

These are project facts confirmed by the current mobile implementation and acceptance run. General
surface procedure stays in `.agents/skills/acceptance/surfaces/`.

## Build identity

- `apps/mobile/android/` and `apps/mobile/ios/` are Expo-generated and untracked. Regenerate the
  applicable native project after Expo config or plugin changes; an old generated directory does
  not prove current source.
- The canonical Android acceptance runner builds and installs a release APK without Metro, verifies
  the package is non-debuggable, and records the APK SHA-256 in its report receipt.
- The iOS build uses the full Xcode selected by `xcode-select` and the existing CocoaPods install.
  `bun run --cwd apps/mobile ios -- --device <udid> --no-bundler` owns the current build command.

## Device ownership

- Every helper takes one explicit device identity. Android uses an ADB serial; iOS uses a Simulator
  UDID. Model names and `booted` are discovery hints, not stable identities.
- The guarded Android release round accepts only disposable emulator serials and clears only
  `com.caxri.mobile` before and after the case.
- A physical Android device and a user-owned iOS Simulator are not disposable. The agent must not
  unlock, erase, reboot, stop, uninstall, or clear their app data without current explicit
  authorization.

## Privacy

- The pairing URL and QR payload are short-lived credentials. They must not appear in Acceptance
  screenshots, videos, accessibility trees, logs, receipts, or report prose.
- `apps/mobile/scripts/android-device.ts semantics` intentionally emits only stable `testID`
  identifiers, enabled/clickable flags, and bounds. Its bridge removes raw UIAutomator XML from the
  device and host after parsing.
- The full Android cross-device path uses a fake Agent and isolated Desktop/Server profile. It never
  invokes a host Agent provider or publishes reply text, Terminal output, Session names, source, or
  Project paths.

## QR decoding

- Android release builds decode QR codes through ML Kit, which instantiates its component
  registrars by reflection. If R8 strips their constructors, scanning silently finds nothing while
  every screen still renders. `MOB-PAIR-04` decodes a bundled pairing-sized vector through the
  same decoder in the release APK, and the Android runner fails any case whose app logged
  `Could not instantiate com.google.mlkit...` (`scripts/mobile-android-native-init.ts`).
- The emulator's virtual camera scene does not show its wall or table posters in the default view,
  so pointing the scan screen at a host-generated QR there proves nothing. To reproduce a decode by
  hand, push a QR image to `/sdcard/Pictures`, index it with
  `adb shell content call --method scan_volume --uri content://media --arg external_primary`, and
  use the scan screen's Choose from Photos action. Camera optics still need a real device.

## Text selection

- On the acceptance emulator, the system text-selection toolbar is a popup that the UIAutomator dump
  does not list, so `mobileNativeControlBounds` cannot find it. Wait for the selection to settle,
  capture the framebuffer, and judge the toolbar by eye; a finished wait is not an assertion.

## Current product limitation

Phase one stores the Mac addresses captured during pairing. When the Mac changes networks or its
local addresses change, the mobile app may need **Forget** followed by a new pairing. Automatic local
discovery is outside phase one.
