# iOS Simulator framebuffer recording

Use this reference only for an iOS Simulator criterion that requires temporal evidence. Record
device pixels directly with `simctl`; this excludes Simulator window chrome. Use one explicit UDID.

## Record and finalize

```bash
xcrun simctl io "$UDID" recordVideo --codec=h264 "$ROUND_DIR/assets/ios-flow.mp4"
```

Start the command in a persistent terminal and wait until it reports that recording started before
driving the scenario. Stop with `Ctrl-C`, not `SIGKILL`, and wait for `simctl` to finalize the movie.
An interrupted command can return a non-zero status after a valid finalization, so judge the file
with `ffprobe`.

## Verify the movie

```bash
ffprobe -v error \
  -show_entries format=duration:stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames \
  -of json "$ROUND_DIR/assets/ios-flow.mp4"
```

Simulator recordings can be variable-frame-rate. Treat a requested rate as a target and preserve
the observed duration, average rate, and frame count.

For one-frame flashes or flicker, extract every encoded frame and compare the generated count with
`ffprobe`'s `nb_frames`. For an ordinary flow, sample at a declared rate and retain the raw video:

```bash
FRAME_DIR=$(mktemp -d)
ffmpeg -i "$ROUND_DIR/assets/ios-flow.mp4" -map 0:v:0 -fps_mode passthrough \
  "$FRAME_DIR/frame_%06d.png"

ffmpeg -i "$ROUND_DIR/assets/ios-flow.mp4" \
  -vf "fps=2,scale=360:-1,tile=4x4:padding=8:margin=8" \
  "$ROUND_DIR/assets/ios-contact-%03d.png"
```

Inspect start, action, transient, and settled states. A contact sheet is an index, not proof of
gesture delivery; pair it with the driver action and fresh Accessibility/postcondition evidence from
[the iOS Simulator surface](../surfaces/ios-simulator.md).
