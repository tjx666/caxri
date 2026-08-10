# Caxri Electron recording via CDP

Use this reference only for Caxri Electron criteria that assert behavior over
time: streaming output, loading-to-loaded transitions, timers, animations, or
multi-step flows. Capture Renderer frames directly through CDP; do not record
the host screen.

## Capture a frame sequence

Run the bounded capture helper in a persistent shell while driving the scenario
from another shell:

```bash
FRAME_DIR=$(mktemp -d)
bun run .agents/skills/acceptance/scripts/capture-renderer.ts frames \
  --out-dir "$FRAME_DIR" \
  --count 40 \
  --interval-ms 250
```

Adjust `--interval-ms` for the transition speed. The helper reads the CDP port
from the owned Acceptance runtime, targets the main Caxri Renderer page, rejects
DevTools and ambiguous targets, and refuses to overwrite an existing frame
sequence. For a secondary window such as Process Explorer, add
`--url-contains process-explorer.html`.

## Assemble and validate the clip

```bash
# The examples use 250ms capture intervals, so 1000 / 250 = 4 frames per second.
# Keep -framerate equal to 1000 / interval-ms when changing the interval.
# MP4. This constant-rate clip proves order, not wall-clock duration.
ffmpeg -y -framerate 4 -i "$FRAME_DIR/frame_%06d.png" \
  -c:v libx264 -crf 23 -pix_fmt yuv420p "$ARTIFACT_DIR/flow.mp4"

# GIF with a generated palette
ffmpeg -y -framerate 4 -i "$FRAME_DIR/frame_%06d.png" \
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
- `ffmpeg`/`ffprobe` are required for derived media. Probe them before the run.
- The helper compensates for capture overhead, but a constant-rate clip still
  proves sequence rather than exact elapsed time. Use timestamped program output
  when duration is part of the criterion.

Choose `gif` versus `video` and submit the artifact using the shared contract in
[evidence.md](./evidence.md).
