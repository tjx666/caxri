/**
 * How a streaming Agent Chat reply's Markdown text nodes arrived, so a client can fade in each run of characters its
 * stream pacer (`createAgentChatStreamPacer`) adds instead of popping it in. Desktop renders each run as a CSS-animated
 * span; Mobile computes each run's opacity from its arrival time. Both keep the same mount grace and run bookkeeping so
 * a reply reads the same on either.
 */

/**
 * Text a revealing reply already holds within this long of its first render is what the reply mounted with (a Chat
 * opened mid-stream), so it shows at once instead of fading in.
 */
const REVEAL_MOUNT_GRACE_MS = 100;

/**
 * Most fading runs a text node keeps by default; older ones join the settled text. The pacer adds at most one run per
 * frame, so the oldest of 90 arrived at least 750ms ago even at 120Hz, past Desktop's `--motion-text-reveal` (500ms).
 * Without this a long streamed paragraph would keep one span per frame. A count rather than a clock keeps the render
 * pure. A client that redraws less often than every frame passes a smaller cap through `nextRevealedRuns`.
 */
const REVEAL_MAX_FADING_RUNS = 90;

/**
 * How one streaming Markdown text node arrived: the runs of characters that appeared together, for `RevealingText` to
 * fade in one span each.
 */
export interface RevealedRuns {
    text: string;
    /**
     * End offset of each run, in arrival order.
     */
    ends: readonly number[];
    /**
     * Text before this offset shows at once; the runs after it fade in.
     */
    settledEnd: number;
}

/**
 * The runs of a text node that mounted at `now` in a reply whose renderer mounted at `revealSince`.
 */
export function initialRevealedRuns(value: string, now: number, revealSince: number): RevealedRuns {
    return {
        text: value,
        ends: [value.length],
        settledEnd: now - revealSince < REVEAL_MOUNT_GRACE_MS ? value.length : 0,
    };
}

/**
 * Appends the characters `value` adds as a new run, settling the oldest past `maxFadingRuns`. Text that stops extending
 * what was shown (a re-parse that moved the node's text) settles at once rather than replaying its fade.
 */
export function nextRevealedRuns(
    runs: RevealedRuns,
    value: string,
    maxFadingRuns = REVEAL_MAX_FADING_RUNS,
): RevealedRuns {
    if (runs.text === value) return runs;
    if (!value.startsWith(runs.text))
        return { text: value, ends: [value.length], settledEnd: value.length };
    const ends = [...runs.ends, value.length];
    const settled = ends.splice(0, Math.max(0, ends.length - maxFadingRuns));
    const settledEnd = Math.max(runs.settledEnd, settled.at(-1) ?? 0);
    return { text: value, ends, settledEnd };
}

/**
 * The fading runs as `[start, end)` offsets after the settled prefix, skipping empty ones.
 */
export function revealedRunRanges({ ends, settledEnd }: RevealedRuns): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let start = settledEnd;
    for (const end of ends) {
        if (!(end > start)) {
            continue;
        }

        ranges.push([start, end]);
        start = end;
    }
    return ranges;
}
