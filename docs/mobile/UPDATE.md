# Mobile updates from Desktop

A paired Android phone updates itself from the Desktop it is paired with. Each Desktop release
carries the matching release-signed arm64 APK, so a phone never needs `adb`, a cable, or a download
site to follow Desktop.

## User flow

1. After a Desktop upgrade, the phone reads `mobile.update.check` when it connects and comes to the
   foreground (at most every ten minutes).
2. When the bundle's `versionCode` is newer than the installed one, Sessions shows an **Update
   available** banner with **Later** and **Update**. **Later** hides the banner for that version
   only; Settings keeps an **Update to X** row below **Version** for the whole time an update exists.
3. **Update** downloads the APK from Desktop over the LAN with a progress percentage, verifies its
   size and MD5, and opens the Android package installer. Android asks once for the
   "install unknown apps" permission for Caxri.
4. A failed or incomplete download says so and offers **Retry**; nothing is installed.

Development clients (`__DEV__`) and iOS never check for updates: a debug-signed client cannot
accept the release-signed APK.

## Transport

The update rides the paired device's authority, but not its encrypted channel: sealing a ~40 MB
APK in 64 KiB frames with pure-JS crypto is too slow on a phone.

- `mobile.update.check` (every role) returns the bundle manifest (`version`, `versionCode`,
  `sizeBytes`, `md5`) or `null` when this Desktop build carries no APK.
- `mobile.update.prepare` (every role) issues a 256-bit bearer token over the sealed channel and
  returns `http://<gateway address>:<port>/mobile/update/<token>` on the gateway's existing HTTP
  server. The token lives ten minutes, is replaced by the next prepare from the same device, and is
  revoked with the device or when the gateway stops. At most two downloads stream at once.
- The MD5 arrives over the sealed channel and is checked after download. Tamper resistance comes
  from Android itself: an upgrade must carry the installed app's signing certificate, which only
  the private release key produces.

Every download attempt logs `mobile_gateway.update_download` with `outcome`
(`served | unknownToken | expired | unauthorized | capacity | interrupted`), `bytes`, and
`durationMs`.

## Versioning

`apps/mobile/package.json` is a product manifest: `release:prepare` bumps it with Desktop, and
`app.config.ts` derives `versionCode = major * 1_000_000 + minor * 1_000 + patch` from it, so every
Desktop release carries a strictly newer phone build.

## Release signing

The release APK is signed with a private key that never enters the repository. The
`with-android-release-signing` config plugin makes the Gradle `release` build type use it whenever
these variables are set, and fall back to the debug key otherwise:

| Variable                          | Meaning                       |
| --------------------------------- | ----------------------------- |
| `CAXRI_ANDROID_KEYSTORE_PATH`     | Absolute path to the keystore |
| `CAXRI_ANDROID_KEYSTORE_PASSWORD` | Keystore password             |
| `CAXRI_ANDROID_KEY_ALIAS`         | Key alias inside the keystore |
| `CAXRI_ANDROID_KEY_PASSWORD`      | Key password                  |

Create the key once, keep an offline backup, and never commit it. Losing it means every phone must
uninstall and re-pair once more:

```sh
keytool -genkeypair -keystore ~/.config/caxri/android-release.jks -alias caxri \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Caxri"
```

The release workflow reads the same values from the repository secrets
`CAXRI_ANDROID_KEYSTORE_BASE64` (`base64 -i android-release.jks`), `CAXRI_ANDROID_KEYSTORE_PASSWORD`,
`CAXRI_ANDROID_KEY_ALIAS`, and `CAXRI_ANDROID_KEY_PASSWORD`, and decodes the keystore into
`$RUNNER_TEMP` only for the build step.

Switching an installed phone from a debug-signed build to the release key is a one-time uninstall,
install, and re-pair: Android refuses to upgrade across signing certificates.

## Building the bundle

```sh
bun run --cwd apps/mobile build:update-bundle
```

With the signing variables set and the Android toolchain from `apps/mobile/README.md` installed,
the script regenerates the native project, builds the `arm64-v8a` optimized release APK, and
verifies with `aapt2`, `apksigner`, and `keytool` that it is `com.caxri.mobile` at the current
version and signed only by the release key. It then stages `out/mobile-update/caxri-mobile.apk` and
`manifest.json`, which electron-builder copies to `Caxri.app/Contents/Resources/mobile`. Any missing
variable, missing tool, or identity mismatch fails the build instead of shipping a Desktop without
its phone build; the release workflow also compares the packaged copy byte for byte.

For a development Server, point `CAXRI_MOBILE_UPDATE_DIRECTORY` at a directory holding the same two
files. A packaged Server without the directory, or a directory without `manifest.json`, simply
offers no update.

## Non-goals

- A phone whose transport protocol no longer matches Desktop cannot connect, so it cannot receive
  the update that would fix it; reinstall with `adb` in that case.
- Only `arm64-v8a` is bundled. Other ABIs keep the manual flow in `APK-SIZE.md`.
