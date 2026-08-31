# Android framebuffer recording

Use this reference only when an Android acceptance criterion depends on visible behavior over time.
Use one explicit disposable emulator serial and record device pixels rather than the host emulator
window.

## Record

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
SERIAL=emulator-5554
DEVICE_VIDEO=/data/local/tmp/caxri-acceptance.mp4

"$ADB" -s "$SERIAL" shell screenrecord --bit-rate 8000000 "$DEVICE_VIDEO"
```

Run `screenrecord` in its own persistent terminal, wait until it is active, drive the pre-authored
scenario, then stop it with `Ctrl-C`. Pull the finalized file and remove only that exact device path:

```bash
"$ADB" -s "$SERIAL" pull "$DEVICE_VIDEO" "$ROUND_DIR/assets/android-flow.mp4"
"$ADB" -s "$SERIAL" shell rm -f "$DEVICE_VIDEO"
```

Never record a QR code, pairing link, Terminal preview, Session name, notification, keyboard
suggestion, or another app. If such content enters a frame, the artifact is invalid; do not crop or
blur it into passing evidence. Reset the isolated case and capture a fresh round.

## Verify and review

```bash
ffprobe -v error \
  -show_entries format=duration:stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames \
  -of json "$ROUND_DIR/assets/android-flow.mp4"
```

Inspect the raw video plus start, action, transient, and settled frames. Extract every frame for a
flicker or one-frame flash; otherwise declare a sampling rate and retain the original video. A
contact sheet is a review index, not temporal evidence, and a video alone does not prove which touch
was delivered. Pair it with the sanitized semantic command and observed postcondition from
[the Android surface](../surfaces/android.md).
