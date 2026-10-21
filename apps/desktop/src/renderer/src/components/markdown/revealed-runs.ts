/**
 * Text a revealing reply already holds within this long of its first render is what the reply mounted with (a Chat
 * opened mid-stream), so it shows at once instead of fading in.
 */
const MOUNT_GRACE_MS = 100;

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
        settledEnd: now - revealSince < MOUNT_GRACE_MS ? value.length : 0,
    };
}

/**
 * Appends the characters `value` adds as a new run. Text that stops extending what was shown (a re-parse that moved the
 * node's text) settles at once rather than replaying its fade.
 */
export function nextRevealedRuns(runs: RevealedRuns, value: string): RevealedRuns {
    if (runs.text === value) return runs;
    if (!value.startsWith(runs.text))
        return { text: value, ends: [value.length], settledEnd: value.length };
    return { ...runs, text: value, ends: [...runs.ends, value.length] };
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
