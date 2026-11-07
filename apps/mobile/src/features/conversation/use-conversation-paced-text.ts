import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';

import { createAgentChatStreamPacer } from '@caxri/protocol';

/**
 * The phone redraws a paced reply at most this often: each redraw re-parses the whole reply's Markdown, so half the
 * display rate keeps a long reply smooth without spending every frame on parsing.
 */
const MIN_REDRAW_MS = 32;

/**
 * A streaming Agent Chat reply's text, paced onto the screen (see `createAgentChatStreamPacer`) so bursty deltas read
 * as steady typing, as Desktop paces it. Text present when the row mounts shows at once. When `isStreaming` turns false
 * while part of the reply is still hidden, the rest drains in a few hundred milliseconds (the pacer's `finish`) rather
 * than landing as one block, so a completed, failed, or interrupted turn is never left mid-reveal for long. With
 * reduced motion enabled the typing effect is skipped and the full text shows as it arrives.
 *
 * `shownAt` is when the pacer last advanced the text (`performance.now()`), for a reply that fades in what it adds; it
 * is read in the frame callback because a render must not read the clock. `isPacing` is whether the returned text is
 * still being revealed, streaming or draining its rest.
 */
export function useConversationPacedText(
    text: string,
    isStreaming: boolean,
): { isPacing: boolean; text: string; shownAt: number } {
    const [pacer] = useState(() => createAgentChatStreamPacer(text));
    const [shown, setShown] = useState(() => ({ text, shownAt: performance.now() }));
    const isReducedMotion = useReducedMotion();
    /**
     * Kept across loop restarts: every delta restarts the loop, and a per-loop clock would redraw on each one's first
     * frame, so a stream of deltas arriving faster than `MIN_REDRAW_MS` would re-parse the reply every frame.
     */
    const lastRedrawAt = useRef<number | undefined>(undefined);
    /**
     * A reply that stopped streaming keeps pacing only to drain what it already started revealing: its final text must
     * continue what is shown. Anything else (a rewrite, a row that mounted finished) shows whole.
     */
    const isDraining = !isStreaming && shown.text !== text && text.startsWith(shown.text);
    const isPacing = (isStreaming || isDraining) && !isReducedMotion;
    useEffect(() => {
        if (!isPacing) return;
        const isFinish = !isStreaming;
        // Each delta restarts the loop with the longer target; the pacer carries the reveal across restarts.
        let frame = requestAnimationFrame(function step(now) {
            const last = lastRedrawAt.current;
            if (last !== undefined && now - last < MIN_REDRAW_MS) {
                frame = requestAnimationFrame(step);
                return;
            }
            lastRedrawAt.current = now;
            const next = pacer.next(text, now, { finish: isFinish });
            setShown((current) =>
                current.text === next ? current : { text: next, shownAt: performance.now() },
            );
            if (next !== text) frame = requestAnimationFrame(step);
        });
        return () => cancelAnimationFrame(frame);
    }, [isPacing, isStreaming, pacer, text]);
    return isPacing ? { isPacing, ...shown } : { isPacing, text, shownAt: shown.shownAt };
}
