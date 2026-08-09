# Caxri Electron recording via CDP

Use this reference only for Caxri Electron criteria that assert behavior over
time: streaming output, loading-to-loaded transitions, timers, animations, or
multi-step flows. Capture renderer frames through `agent-browser`; do not record
the host screen.

## Capture a frame sequence

Run the capture loop in a persistent shell while driving the scenario from
another shell:

```bash
FRAME_DIR=$(mktemp -d)

capture_frame() { agent-browser --cdp "$PORT" screenshot html "$1"; }

i=0
while [ "$i" -lt 40 ]; do # about 20 seconds at 0.5 seconds per frame
  printf -v frame_number "%06d" "$i"
  capture_frame "$FRAME_DIR/frame_$frame_number.png"
  i=$((i + 1))
  sleep 0.5
done
```

Use a shorter interval such as `0.25` seconds for quick transitions and a longer
interval such as `1` second for slow flows. Keep the capture scoped to the
behavior under review.

## Assemble and validate the clip

```bash
# MP4. This constant-rate clip proves order, not wall-clock duration.
ffmpeg -y -framerate 2 -i "$FRAME_DIR/frame_%06d.png" \
  -c:v libx264 -crf 23 -pix_fmt yuv420p "$ARTIFACT_DIR/flow.mp4"

# GIF with a generated palette
ffmpeg -y -framerate 2 -i "$FRAME_DIR/frame_%06d.png" \
  -vf "scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  "$ARTIFACT_DIR/flow.gif"

ffprobe -v error \
  -show_entries format=duration:stream=codec_name,width,height,avg_frame_rate,nb_frames \
  -of json "$ARTIFACT_DIR/flow.mp4"
```

Inspect the first frame, action frame, transient state, and settled frame before
citing the artifact. Keep the original frame directory until verification is
published; it is useful when a reviewer asks about a one-frame defect.

## Boundaries

- CDP frames include the Caxri renderer and exclude Electron/macOS window chrome.
- A file picker, permission prompt, menu, or other OS-owned element is not
  present in these frames. State that limitation when it matters to the claim.
- `agent-browser` and `ffmpeg`/`ffprobe` are required. Probe them before the run.
- The capture loop includes command overhead, so a constant-rate clip proves
  sequence but not elapsed time. Use timestamped program output when duration is
  part of the criterion.

Choose `gif` versus `video` and submit the artifact using the shared contract in
[evidence.md](./evidence.md).
