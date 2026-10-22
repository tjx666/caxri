import { useEffect, useState } from 'react';

import { createAgentChatStreamPacer } from '@caxri/protocol';

/**
 * A streaming reply's text, paced onto the screen a frame at a time (see `createAgentChatStreamPacer`) so an uneven
 * stream of deltas reads as steady typing. Text present when the reply mounts shows at once, and the whole text shows
 * the moment `isStreaming` turns false: a completed, failed, or interrupted turn is never left mid-reveal.
 */
export function useAgentChatPacedText(text: string, isStreaming: boolean): string {
    const [pacer] = useState(() => createAgentChatStreamPacer(text));
    const [shown, setShown] = useState(text);
    useEffect(() => {
        if (!isStreaming) return;
        // Each delta restarts the loop with the longer target; the pacer carries the reveal across restarts.
        let frame = 0;
        const step = (now: number): void => {
            const next = pacer.next(text, now);
            setShown(next);
            if (next !== text) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [isStreaming, pacer, text]);
    return isStreaming ? shown : text;
}
