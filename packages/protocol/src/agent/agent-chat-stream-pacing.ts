/**
 * Paces a streaming Agent reply onto the screen. Providers deliver text in uneven bursts (a word, then nothing, then a
 * whole paragraph), and Server Core forwards each burst as it arrives, so drawing every delta as is makes a reply
 * stutter. The pacer reveals the received text a little behind its arrival instead: each frame shows a share of what is
 * still hidden, so a burst eases in over a few frames while a steady stream stays only a few characters behind it.
 *
 * It never holds text back for long: the first character of a reply shows on the first frame, a backlog drains in
 * roughly {@link AGENT_CHAT_STREAM_DRAIN_MS}, and a caller stops pacing (showing the whole text at once) the moment the
 * turn completes, fails, or is interrupted. LobeHub's `useSmoothStreamContent` paces its replies the same way, with an
 * adaptive rate and a short buffer; this keeps only its core idea, a reveal rate proportional to the backlog.
 */

/**
 * How long a burst takes to ease in, roughly: each frame reveals the hidden share of the text that this window would
 * drain at the current rate. Short enough that the reader never waits on text that already arrived.
 */
export const AGENT_CHAT_STREAM_DRAIN_MS = 180;

/**
 * The slowest reveal, in characters per second, so the last few characters of a burst do not trickle in one by one.
 */
const MIN_CHARACTERS_PER_SECOND = 90;

/**
 * The frame time assumed for the first frame and after any gap longer than {@link MAX_FRAME_MS}, so a reply resuming
 * after a silence, or a frame the system delayed, eases in rather than jumping by a whole window of text.
 */
const NOMINAL_FRAME_MS = 16;
const MAX_FRAME_MS = 50;

export interface AgentChatStreamPacer {
    /**
     * The part of `target`, the reply received so far, to show at `now` (a monotonic millisecond clock such as
     * `requestAnimationFrame`'s timestamp). A `target` that does not extend what is shown (a rewound or edited reply)
     * is shown whole at once.
     */
    next(target: string, now: number): string;
}

/**
 * @param initial - Text already on screen when pacing starts, such as a reply restored mid-stream; it is shown whole,
 *   never replayed.
 */
export function createAgentChatStreamPacer(initial = ''): AgentChatStreamPacer {
    let shown = initial;
    let lastFrameAt: number | undefined;
    let carry = 0;
    return {
        next(target, now) {
            if (!target.startsWith(shown)) {
                shown = target;
                carry = 0;
                lastFrameAt = undefined;
                return shown;
            }
            const backlog = target.length - shown.length;
            if (backlog === 0) {
                // Caught up: the next burst starts from a nominal frame, not from the pause before it.
                lastFrameAt = undefined;
                carry = 0;
                return shown;
            }
            const gap =
                lastFrameAt === undefined ? NOMINAL_FRAME_MS : Math.max(now - lastFrameAt, 0);
            const elapsed = gap > MAX_FRAME_MS ? NOMINAL_FRAME_MS : gap;
            lastFrameAt = now;
            carry += Math.max(
                (MIN_CHARACTERS_PER_SECOND * elapsed) / 1_000,
                (backlog * elapsed) / AGENT_CHAT_STREAM_DRAIN_MS,
            );
            let count = Math.min(Math.floor(carry), backlog);
            // The first character of a reply shows at once, so pacing never reads as a slow start.
            if (count === 0 && shown.length === 0) count = 1;
            carry -= count;
            let end = shown.length + count;
            // Never end on the first half of a surrogate pair, which would draw a replacement glyph for a frame.
            // A code point above U+FFFF starting at the last shown index means it is a high surrogate with its pair next.
            if ((target.codePointAt(end - 1) ?? 0) > 0xff_ff) end += 1;
            shown = target.slice(0, end);
            return shown;
        },
    };
}
