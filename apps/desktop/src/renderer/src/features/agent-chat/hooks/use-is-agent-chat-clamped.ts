import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/**
 * Whether a line-clamped block hides lines, so the message can offer "Show more". It measures only while the clamp
 * applies (`isClamped`); once the user expands the block, the last measurement stands, so "Show less" stays offered for
 * a block that was cut. A narrower pane re-wraps the text, so the box is observed, and `content` re-measures a block
 * whose text changed inside the same box.
 */
export function useIsAgentChatClamped(
    reference: RefObject<HTMLElement | null>,
    { content, isClamped }: { content: string; isClamped: boolean },
): boolean {
    const [isCut, setCut] = useState(false);
    useEffect(() => {
        const element = reference.current;
        if (!element || !isClamped) return;
        /**
         * One pixel of slack absorbs sub-pixel line boxes that would otherwise read as a permanent cut.
         */
        const measure = (): void => setCut(element.scrollHeight > element.clientHeight + 1);
        /**
         * Measured only from the observer, which reports right after the browser lays the box out: reading the height
         * on mount forces a layout per message, and a page of history read back mounts a hundred of them at once. A
         * message offscreen in that history is not laid out at all (`content-visibility: auto`) until it scrolls near.
         */
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [content, isClamped, reference]);
    return isCut;
}
