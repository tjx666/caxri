# Android internal APK size

The internal APK is a release variant signed by the generated debug keystore unless the release
signing variables from [UPDATE.md](UPDATE.md) are set. Keep the same
`app.config.ts` package name, `versionCode`, and signing certificate when replacing an installed
test build. An ABI-specific APK installs only on a device with that ABI; keep the universal build
for cross-device validation and choose `arm64-v8a` only after checking the target device.

## Reproduce the comparison

Run each command from one clean source commit after `prebuild:android -- --clean`. Copy the output
APK to a distinct, ignored location after each build because Gradle reuses
`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

```sh
bun run --cwd apps/mobile prebuild:android -- --clean
bun run --cwd apps/mobile android -- --build-only --variant release
bun run --cwd apps/mobile android -- --build-only --variant release --abi arm64-v8a
bun run --cwd apps/mobile android -- --build-only --variant release --abi arm64-v8a --minify
bun run --cwd apps/mobile android -- --build-only --variant release --abi arm64-v8a --optimize
```

`--minify` enables R8. `--optimize` enables R8 and resource shrinking. For an arm64 internal
installation use the final command, then rename the copied APK to include the app version and ABI,
for example `caxri-mobile-0.0.25-arm64-v8a.apk`. Never infer a size gain from the test pages:
compare the APK's actual byte count and the compressed ZIP entries for `lib/<abi>/`, `classes*.dex`,
`res/` plus `resources.arsc`, and `assets/` at the same source commit.

Before installing, record each APK's SHA-256, byte count, `aapt dump badging` package, version and
`native-code`, and `apksigner verify --print-certs` certificate digest. For an in-place upgrade,
compare package, a non-decreasing `versionCode`, and certificate digest with the installed build before
`adb -s <serial> install -r <apk>`. A successful install alone does not prove preservation of
SecureStore pairing; open the app and confirm its existing pairing and core flows. Never uninstall
or clear data on a physical test device to make an upgrade pass.

The disposable emulator may use the universal or an ABI-specific test APK matching
`adb -s <serial> shell getprop ro.product.cpu.abi`. The release acceptance runner still builds a
universal APK so its emulator coverage remains independent of the arm64 internal artifact.
