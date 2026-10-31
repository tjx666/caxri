---
kind: living
status: current
---

# Mobile updates from Desktop

A paired Android phone updates itself from the Desktop it is paired with. Each Desktop release
carries the matching release-signed arm64 APK, so a phone never needs `adb`, a cable, or a download
site to follow Desktop. The other direction, updating the computer from the phone, is
[Updating the computer from the phone](desktop-update.md).

## Install from GitHub Releases

For a first install, open the [latest Release](https://github.com/tjx666/caxri/releases/latest)
on an arm64 Android phone and download `Caxri-Mobile-<version>-android-arm64.apk` from **Assets**.
Open the APK, enable **Allow from this source** for the browser or file manager if Android asks,
and tap **Install**. Open Caxri, then pair it from Desktop's **Settings > Mobile**. Keep Desktop
and Mobile on the same release version.

New releases publish the exact release-signed APK embedded in both Desktop DMG flavors.
An existing release can receive a separate APK rebuilt from its fixed published tag using the
same release signing key. Its Release notes identify that source commit; the original DMGs stay
unchanged and may not contain an update bundle. This backfill supplies the first-install download
without changing the already published Desktop artifacts.
Its `.sha256` companion names only the APK filename, so it can be checked from the download
directory with `shasum -a 256 -c <apk-filename>.sha256`. The release fails if the APK is missing.
Subsequent APK installs and Desktop-delivered updates use the same signing key and preserve app
data. An existing debug-signed development client cannot be upgraded with the release-signed APK
in place. Switching to the release app requires uninstalling that development client first, which
clears its local app data and requires pairing again.

iOS builds remain a source-development workflow. GitHub Releases do not provide an installable
IPA; distributing to iPhones requires a separate Apple signing and distribution setup.

## User flow

1. After a Desktop upgrade, the phone reads `mobile.update.check` when it connects and comes to the
   foreground (at most every ten minutes).
2. When the bundle's `versionCode` is newer than the installed one, Sessions shows an **Update
   available** banner with **Later** and **Update**. **Later** hides the banner for that version
   only; Settings keeps an **Update to X** row below **Version** for the whole time an update exists.
   Otherwise the **Version** row reads **Up to date** once Desktop answered, and tapping it asks
   again at once instead of waiting for the ten-minute window.
3. **Update** downloads the APK from Desktop over the LAN with a progress percentage, verifies its
   size and MD5, and opens the Android package installer. Over the Relay it downloads the same APK
   from that version's GitHub Release instead (see [Transport](#transport)). Android asks once for the
   "install unknown apps" permission for Caxri.
4. A failed or incomplete download says so and offers **Retry**; nothing is installed.
5. When a Desktop upgrade raised the mobile transport version, the phone's reconnect is refused
   before authentication. The phone then asks that Desktop for its build through update recovery
   (below). If Desktop ships a newer build, Sessions shows **Update required** with "This computer
   runs a newer Caxri. Update this app to reconnect." and an **Update** action that uses the same
   download, progress, verification, and installer flow; there is no **Later**. The updated app
   restarts and reconnects normally. When the question itself fails, for example on a timeout, the
   banner says so and offers **Retry**. Without a newer build, or when Desktop rejects the pairing,
   the banner asks to update both sides manually.

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
- Over the Relay, the gateway has no address the phone can reach, so `mobile.update.prepare`
  returns the `Caxri-Mobile-<version>-android-arm64.apk` asset of that version's public GitHub
  Release instead. It is the exact APK the Desktop build embeds, so the same MD5 check applies. A
  build that was never published as a Release has no such asset, and the download fails with
  **Retry**. Update recovery stays direct-only.
- The MD5 arrives over the sealed channel and is checked after download. Tamper resistance comes
  from Android itself: an upgrade must carry the installed app's signing certificate, which only
  the private release key produces.

Every download attempt logs `mobile_gateway.update_download` with `outcome`
(`served | unknownToken | expired | unauthorized | capacity | interrupted`), `bytes`, and
`durationMs`.

## Update recovery

A version mismatch refuses the phone before authentication, so the sealed channel above is not
available. `update-recovery-v1` is a separate, frozen exchange on the same gateway WebSocket
endpoint. It never changes when `MOBILE_TRANSPORT_VERSION` is bumped: its schemas and crypto live in
`packages/mobile-transport/src/update-recovery.ts`, import nothing from the versioned transport
contract, and ignore unknown fields so later Desktops can extend it additively. A breaking change
needs a new protocol identifier served beside v1.

1. The phone receives `version-mismatch` with a `supportedVersion` newer than its own. Only then,
   and only with a stored pairing, it opens a new socket and sends
   `update-recovery-hello {deviceId, generation, clientNonce}`.
2. Desktop answers every well-formed hello with `update-recovery-challenge {serverNonce}`, so the
   challenge never reveals whether the device is paired.
3. The phone derives a one-exchange key with HKDF-SHA256 from its pairing credential, salted with
   a hash of the Desktop `serverId`, `deviceId`, `generation`, and both nonces, and sends
   `update-recovery-proof {proof}`, an HMAC with that key.
4. Desktop re-reads the device record, verifies the proof in constant time, and re-checks the
   record after reading the bundle. A device whose revocation has started counts as revoked even
   before the registry write finishes, and starting a revocation also drops that device's live
   download URLs. It then sends one `update-recovery-result {payload, proof}` and
   closes. `payload` is the exact JSON text of `{bundle, url, expiresAt}` (or `{bundle: null}`)
   and `proof` authenticates it, so a LAN peer cannot substitute the URL or MD5. The URL is the same
   ten-minute, per-device token `mobile.update.prepare` issues.
5. An unpaired, revoked, stale-generation, or wrongly proven device receives the same
   `update-recovery-rejected` and no URL. A captured proof never verifies again because each
   exchange uses a fresh server nonce.

The recovery socket never becomes an application session: it cannot reach the command dispatcher,
subscriptions, or any data beyond the manifest and that device's own download URL. The check and
the **Update** action each run their own exchange, so the URL used for the download is always
fresh. Desktop issues a URL only to a proven device, but it does not keep the URL secret: like the
ordinary download, whose `GET` carries the same token in the clear, it crosses the LAN
unencrypted, so a peer that observes the exchange can fetch the APK until the token expires. That
is acceptable because the APK is not confidential; its integrity rests on the authenticated MD5
and Android's signing-certificate check.

Every exchange logs `mobile_gateway.update_recovery` with one closed `outcome`: `accepted`,
`no-bundle`, `unpaired`, `revoked`, `stale-generation`, `bad-proof`, `invalid-frame`,
`unavailable`, or `bundle-error`. The phone always sees the same rejection; only the log tells the
reasons apart.

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

- Update recovery works only for a phone build that already ships `update-recovery-v1`. A phone
  installed before it cannot recover after a transport bump and needs one manual reinstall, for
  example with `adb`.
- An unpaired phone, including one scanning a pairing link from a newer Desktop, cannot recover.
- Only `arm64-v8a` is bundled. Other ABIs keep the manual flow in `apk-size.md`.
