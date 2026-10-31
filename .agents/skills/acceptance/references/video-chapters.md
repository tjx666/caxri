# Video chapters

A recording without chapters asks the reviewer to watch all of it to find the
two seconds that matter. Chapters put your steps and your claims on the video's
timeline: the reviewer jumps to each claim, checks the frame, and rejects the
exact moment you got wrong.

Attach chapters to every `video` evidence you capture yourself. They cost one
command per step while you drive the scenario. Write `label` and `note` in
Simplified Chinese, like every other human-facing report field.

## The three kinds

| Kind    | Means                                                            | Required text        |
| ------- | ---------------------------------------------------------------- | -------------------- |
| `step`  | An action you performed: "切换到第二个 Session"                  | `label` (short name) |
| `check` | Something you verified **on this frame**                         | `note` (the claim)   |
| `flag`  | An anomaly you noticed and judged harmless, disclosed for review | `note` (what & why)  |

`t` is seconds from the start of the video.

- **A `check` is true of its own frame, not of the whole clip.** "第 3 次切换后这一帧没有背景色条",
  not "全程没有背景色条". The reviewer seeks to `t` and judges the claim against that picture.
- **Write a `flag` for every anomaly you saw, even one you consider harmless**: a one-frame
  flash, a layout jump, a spinner that restarted. An anomaly the reviewer finds that you did not
  disclose reads as concealment and costs more trust than the anomaly itself.
- **A `check` is a claim to audit, never a pass.** It does not replace the case `observation`,
  the frames you inspected, or the reviewer's judgement.
- **Timestamps come from logs, not memory.** Log each mark while driving (below) and derive `t`
  from the recording's own timeline. Before publishing, extract the frame at each `check` and
  `flag` and confirm it shows what the note says.

## Log marks while you drive

Author the mark commands with the rest of the case before launch, so the desktop
[human-focus boundary](../SKILL.md#boundaries) holds. Record wall-clock marks beside the frames:

```bash
MARKS="$FRAME_DIR/marks.jsonl"
mark() { # mark <step|check|flag> <text>
  python3 -c 'import json,sys,time; print(json.dumps({"wall": time.time(), "kind": sys.argv[1], "text": sys.argv[2]}, ensure_ascii=False))' "$1" "$2" >> "$MARKS"
}

mark step "切换到第二个 Session"
# ... drive the product ...
mark check "第 3 次切换后终端视口铺满工作区"
mark flag "第 2 次切换时侧栏闪了一帧加载态，随后恢复，内容未变化"
```

## Convert marks into chapters

`capture-renderer.ts frames` writes `frames.log` (`<frame file> <epoch seconds>` per frame), and
[recording-cdp.md](./recording-cdp.md) assembles a constant-rate clip in which frame `i` plays at
`i * interval-ms / 1000` seconds. Map each mark to the last frame taken at or before it:

```bash
INTERVAL_MS=250 # the --interval-ms the frames were captured with
python3 - "$FRAME_DIR/frames.log" "$MARKS" "$INTERVAL_MS" > "$FRAME_DIR/chapters.json" <<'PY'
import json, sys
times = [float(line.split()[1]) for line in open(sys.argv[1])]
interval = int(sys.argv[3]) / 1000
chapters = []
for line in open(sys.argv[2]):
    m = json.loads(line)
    index = max([i for i, at in enumerate(times) if at <= m["wall"]], default=0)
    key = "label" if m["kind"] == "step" else "note"
    chapters.append({"kind": m["kind"], "t": round(index * interval, 2), key: m["text"]})
print(json.dumps(chapters, ensure_ascii=False, indent=1))
PY
```

For Android `screenrecord` and iOS `simctl` recordings, log `mark step "开始录制"` the moment the
recorder reports it started and use `wall - start` as `t`; those recorders keep real time.

## Attach them

Copy the array into the `video` evidence entry's `chapters`
([report.md](./report.md#video-chapters)), then extract the frame at each `check` and `flag`:

```bash
ffmpeg -y -ss 7.9 -i "$ARTIFACT_DIR/flow.mp4" -frames:v 1 "$FRAME_DIR/check-7.9.png"
```

Read every extracted frame. A note that its frame does not show is a wrong claim: fix the note or
the timestamp before finalizing, never the frame.
