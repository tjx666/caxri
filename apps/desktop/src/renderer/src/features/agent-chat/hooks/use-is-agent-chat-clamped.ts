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
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [content, isClamped, reference]);
    return isCut;
}
