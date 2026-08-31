# iOS Simulator surface

Use this surface for native iOS rendering, navigation, gestures, lifecycle, system sheets, or
device-size layout. The canonical report surface is `mobile`. This workflow requires macOS, full
Xcode, an installed Simulator runtime, and a shell-accessible Simulator Accessibility/HID driver for
interaction claims.

## Proof contract

Separate the planned claim before testing:

1. the current source produced the installed binary;
2. the expected static UI is visible;
3. the intended native touch or gesture was delivered;
4. the expected postcondition appeared;
5. any hardware-only behavior is deferred to a physical device.

Record branch, commit, dirty state, build command, Xcode version, Simulator model/runtime/UDID,
bundle id `com.caxri.mobile`, and tested time. An old installed app or a host-window screenshot is not
current-source evidence.

## Select a driver without installing software

Probe the host before planning interaction evidence:

```bash
command -v axe
command -v idb
command -v idb_companion
xcrun simctl help io
```

Prefer AXe, then a repository-owned XCUITest/CLI driver, then `idb` only when both client and
companion are installed. `simctl` owns device lifecycle and framebuffer capture but does not provide
general app touch automation. A macOS Accessibility click on the Simulator window is a smoke test,
not proof that the native gesture was delivered.

Do not install a missing driver without authorization. If no installed driver can express the
planned action, mark that interaction case `blocked`; a static screenshot may satisfy only a
separately planned static-layout check.

## Establish the tested build

Choose one UDID and continue using it instead of `booted`:

```bash
UDID=<simulator-udid>
xcrun simctl list devices booted --json > "$ROUND_DIR/assets/ios-devices.json"
xcodebuild -version > "$ROUND_DIR/assets/xcode-version.txt"
bun run --cwd apps/mobile ios -- --device "$UDID" --no-bundler
xcrun simctl launch --terminate-running-process "$UDID" com.caxri.mobile
```

When Expo configuration or plugins changed, regenerate the iOS project from `apps/mobile` before the
build:

```bash
bun run --cwd apps/mobile prebuild:ios -- --clean
```

Do not erase a user-owned Simulator. Use `stateIsolation.mode: "readonly_checkpoint"` only for a
genuinely non-mutating observation. A mutating case needs a Simulator explicitly designated as
disposable and a recorded app-container cleanup; otherwise mark it `blocked`.

Every outcome still needs `assets/<case-id>-mobile-device.json`. Record the frozen UDID and iOS
platform, the installed build identity when available (otherwise `unavailable`), cleanup state, and
`passed`, `failed`, or `blocked` matching the case result. Bind the receipt to the frozen report
commit and final state-isolation launch id, or to the frozen checkpoint id for
`readonly_checkpoint`. A blocked receipt identifies the intended target; it must not claim that the
application launched.

## Inspect, interact, and verify

Read the Accessibility hierarchy before choosing selectors or coordinates:

```bash
axe describe-ui --udid "$UDID" > "$ROUND_DIR/assets/ios-before-ui.txt"
axe tap --id pairing-scan-button --wait-timeout 5 --post-delay 0.5 --udid "$UDID"
axe describe-ui --udid "$UDID" > "$ROUND_DIR/assets/ios-after-ui.txt"
```

Prefer accessibility identifiers, then label plus element type. Use coordinates only after the
hierarchy identifies one valid frame. A successful driver command proves dispatch, not product
response; always read the post-state.

Capture clean device pixels with `simctl` and inspect the image:

```bash
xcrun simctl io "$UDID" screenshot --type=png "$ROUND_DIR/assets/ios-state.png"
```

Check clipping, overlap, safe areas, keyboard coverage, hierarchy, selected state, target identity,
and phone/tablet behavior. Follow
[the iOS Simulator recording guide](../references/recording-ios-simulator.md) for transitions and
multi-step flows. Simulator evidence cannot establish haptics, camera quality, thermal behavior,
energy use, or physical-device performance.
