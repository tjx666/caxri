import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

import {
    AGENT_CHAT_USER_MESSAGE_ATTRIBUTE,
    agentChatActiveRailIndex,
} from '../agent-chat-rail-marks';
import { isScrolledToEnd } from './use-agent-chat-scroll';

/**
 * Space left above a message the rail jumps to, so it does not sit flush against the top edge.
 */
const JUMP_MARGIN_PX = 12;

function messageElement(content: HTMLElement, id: string): HTMLElement | null {
    return content.querySelector<HTMLElement>(
        `[${CSS.escape(AGENT_CHAT_USER_MESSAGE_ATTRIBUTE)}="${CSS.escape(id)}"]`,
    );
}

/**
 * Where `element` sits in the scroll view's content coordinates.
 */
function contentTop(view: HTMLElement, element: HTMLElement): number {
    return element.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
}

/**
 * Tracks which user message the reader is at and scrolls to one on request. Positions are measured from the DOM on
 * scroll (one measurement per frame) and whenever the content resizes, since a streamed reply or an expanded work row
 * moves every message below it without a scroll.
 */
export function useAgentChatMessageRail(
    scrollReference: RefObject<HTMLDivElement | null>,
    contentReference: RefObject<HTMLDivElement | null>,
    markIds: readonly string[],
): { activeIndex: number; jumpTo: (id: string) => void } {
    const [activeIndex, setActiveIndex] = useState(-1);
    const idsKey = markIds.join('\n');
    useEffect(() => {
        const view = scrollReference.current;
        const content = contentReference.current;
        if (!view || !content || idsKey === '') return;
        const ids = idsKey.split('\n');
        const measure = (): void => {
            const tops = ids.map((id) => {
                const element = messageElement(content, id);
                return element ? contentTop(view, element) : Infinity;
            });
            setActiveIndex(
                agentChatActiveRailIndex(
                    tops,
                    view.scrollTop + view.clientHeight / 3,
                    isScrolledToEnd(view),
                ),
            );
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
    }, [scrollReference, contentReference, idsKey]);
    const jumpTo = (id: string): void => {
        const view = scrollReference.current;
        const content = contentReference.current;
        const element = content && messageElement(content, id);
        if (!view || !element) return;
        /**
         * Instant rather than smooth: a smooth scroll's first frames still sit within the follow threshold of the end,
         * so their scroll events would resume following and the next layout would pin the view straight back down.
         */
        view.scrollTo({ top: Math.max(contentTop(view, element) - JUMP_MARGIN_PX, 0) });
    };
    return { activeIndex, jumpTo };
}
