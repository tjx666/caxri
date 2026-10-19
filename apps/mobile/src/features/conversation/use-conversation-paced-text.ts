import { useEffect, useState } from 'react';

import { createAgentChatStreamPacer } from '@caxri/protocol';

/**
 * The phone redraws a paced reply at most this often: each redraw re-parses the whole reply's Markdown, so half the
 * display rate keeps a long reply smooth without spending every frame on parsing.
 */
const MIN_REDRAW_MS = 32;

/**
 * A streaming Agent Chat reply's text, paced onto the screen (see `createAgentChatStreamPacer`) so bursty deltas read
 * as steady typing, as Desktop paces it. Text present when the row mounts shows at once, and the whole text shows the
 * moment `isStreaming` turns false, so a completed, failed, or interrupted turn is never left mid-reveal.
 */
export function useConversationPacedText(text: string, isStreaming: boolean): string {
    const [pacer] = useState(() => createAgentChatStreamPacer(text));
    const [shown, setShown] = useState(text);
    useEffect(() => {
        if (!isStreaming) return;
        let lastRedrawAt: number | undefined;
        // Each delta restarts the loop with the longer target; the pacer carries the reveal across restarts.
        let frame = requestAnimationFrame(function step(now) {
            if (lastRedrawAt !== undefined && now - lastRedrawAt < MIN_REDRAW_MS) {
                frame = requestAnimationFrame(step);
                return;
            }
            lastRedrawAt = now;
            const next = pacer.next(text, now);
            setShown(next);
            if (next !== text) frame = requestAnimationFrame(step);
        });
        return () => cancelAnimationFrame(frame);
    }, [isStreaming, pacer, text]);
    return isStreaming ? shown : text;
}
