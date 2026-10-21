import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

import { agentChatMessageElement } from './use-agent-chat-message-rail';

/**
 * Whether user message `anchorId` starts above the scroll view's top, so the reader cannot see where it begins; checked
 * on scroll and whenever the content or view resizes. `undefined` while there is no anchor or it is not rendered.
 */
export function useAgentChatAnchorAbove(
    scrollReference: RefObject<HTMLDivElement | null>,
    contentReference: RefObject<HTMLDivElement | null>,
    anchorId: string | undefined,
): boolean | undefined {
    // Keyed by anchor, so a measurement of the previous anchor never answers for the next one.
    const [measured, setMeasured] = useState<{ anchorId: string; isAbove: boolean | undefined }>();
    useEffect(() => {
        const view = scrollReference.current;
        const content = contentReference.current;
        if (!view || !content || anchorId === undefined) return;
        const measure = (): void => {
            const element = agentChatMessageElement(content, anchorId);
            setMeasured({
                anchorId,
                isAbove: element
                    ? element.getBoundingClientRect().top < view.getBoundingClientRect().top
                    : undefined,
            });
        };
        let frame: number | undefined;
        const schedule = (): void => {
            frame ??= requestAnimationFrame(() => {
                frame = undefined;
                measure();
            });
        };
        measure();
        view.addEventListener('scroll', schedule, { passive: true });
        const observer = new ResizeObserver(schedule);
        observer.observe(content);
        observer.observe(view);
        return () => {
            view.removeEventListener('scroll', schedule);
            observer.disconnect();
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [anchorId, contentReference, scrollReference]);
    return anchorId !== undefined && measured?.anchorId === anchorId ? measured.isAbove : undefined;
}
