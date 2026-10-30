import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

import { isScrolledToEnd } from '../../hooks/use-agent-chat-scroll';
import { AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE } from '../../transcript/agent-chat-history';
import { AGENT_CHAT_TURN_START_ATTRIBUTE } from '../../transcript/agent-chat-timeline';
import {
    AGENT_CHAT_USER_MESSAGE_ATTRIBUTE,
    agentChatActiveRailIndex,
} from '../agent-chat-rail-marks';

/**
 * Space left above a message the rail jumps to, so it does not sit flush against the top edge.
 */
const JUMP_MARGIN_PX = 12;

/**
 * How many frames a jump keeps the message aligned while entries around it render at their real height.
 */
const JUMP_SETTLE_FRAMES = 3;

/**
 * How many frames a jump to an unmounted target waits for the tail-first mount to finish mounting it.
 */
const JUMP_MOUNT_FRAMES = 10;

/**
 * The elements the marks' positions are measured on, by message id, found in one pass. A message in history read back
 * renders inside an entry whose offscreen layout the browser skips (`content-visibility: auto`), and measuring inside
 * it would lay every skipped entry out; the entry's own box has the same top and is always laid out.
 */
function messageElements(content: HTMLElement): Map<string, HTMLElement> {
    const elements = new Map<string, HTMLElement>();
    for (const message of content.querySelectorAll<HTMLElement>(
        `[${CSS.escape(AGENT_CHAT_USER_MESSAGE_ATTRIBUTE)}]`,
    )) {
        const id = message.getAttribute(AGENT_CHAT_USER_MESSAGE_ATTRIBUTE);
        if (id === null) continue;
        elements.set(
            id,
            message.closest<HTMLElement>(`[${CSS.escape(AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE)}]`) ??
                message,
        );
    }
    return elements;
}

/**
 * The element a jump to user message `id` aligns, or `null` when the message is not rendered.
 */
function agentChatMessageElement(content: HTMLElement, id: string): HTMLElement | null {
    const message = content.querySelector<HTMLElement>(
        `[${CSS.escape(AGENT_CHAT_USER_MESSAGE_ATTRIBUTE)}="${CSS.escape(id)}"]`,
    );
    return (
        message?.closest<HTMLElement>(`[${CSS.escape(AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE)}]`) ??
        message
    );
}

/**
 * The element where turn `turnId` begins (`AGENT_CHAT_TURN_START_ATTRIBUTE`), or `null` when none of it is rendered.
 * The first match in document order is the earliest, since a turn split between history read back and the live timeline
 * is marked in both.
 */
export function agentChatTurnStartElement(
    content: HTMLElement,
    turnId: string,
): HTMLElement | null {
    return content.querySelector<HTMLElement>(
        `[${CSS.escape(AGENT_CHAT_TURN_START_ATTRIBUTE)}="${CSS.escape(turnId)}"]`,
    );
}

/**
 * Where `element` sits in the scroll view's content coordinates.
 */
function contentTop(view: HTMLElement, element: HTMLElement): number {
    return element.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
}

/**
 * Tracks which user message the reader is at and scrolls to one, or to where a turn begins, on request. Positions are
 * measured from the DOM whenever the content resizes, since a streamed reply or an expanded work row moves every
 * message below it without a scroll; a scroll frame only compares them with the reading line. A jump calls
 * `stopFollowing` first, so the view stays where it lands instead of following the latest entry. While the tail-first
 * mount is still backfilling, the target may not be in the DOM yet; the jump then calls `mountAll` and aligns once the
 * target renders.
 */
export function useAgentChatMessageRail(
    scrollReference: RefObject<HTMLDivElement | null>,
    contentReference: RefObject<HTMLDivElement | null>,
    markIds: readonly string[],
    stopFollowing: () => void,
    mountAll: () => void,
): {
    activeIndex: number;
    jumpTo: (id: string) => void;
    jumpToTurn: (turnId: string) => void;
} {
    const [activeIndex, setActiveIndex] = useState(-1);
    const idsKey = markIds.join('\n');
    useEffect(() => {
        const view = scrollReference.current;
        const content = contentReference.current;
        if (!view || !content || idsKey === '') return;
        const ids = idsKey.split('\n');
        /**
         * The marks' tops in content coordinates. Scrolling does not move them, so a scroll frame only reads the
         * reading line against them; a resize of the content or view measures them again.
         */
        let tops: number[] | undefined;
        const measure = (): void => {
            if (!tops) {
                const elements = messageElements(content);
                tops = ids.map((id) => {
                    const element = elements.get(id);
                    return element ? contentTop(view, element) : Infinity;
                });
            }
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
            if (frame !== undefined) return;
            frame = requestAnimationFrame(() => {
                frame = undefined;
                measure();
            });
        };
        const remeasure = (): void => {
            tops = undefined;
            schedule();
        };
        measure();
        view.addEventListener('scroll', schedule, { passive: true });
        const observer = new ResizeObserver(remeasure);
        observer.observe(content);
        observer.observe(view);
        return () => {
            view.removeEventListener('scroll', schedule);
            observer.disconnect();
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [scrollReference, contentReference, idsKey]);
    const align = (resolve: (content: HTMLElement) => HTMLElement | null): void => {
        const view = scrollReference.current;
        const content = contentReference.current;
        if (!view || !content) return;
        const element = resolve(content);
        if (!element) {
            mountAll();
            const retry = (frames: number): void => {
                const mounted = scrollReference.current && contentReference.current;
                if (mounted && resolve(mounted)) align(resolve);
                else if (frames > 0) requestAnimationFrame(() => retry(frames - 1));
            };
            requestAnimationFrame(() => retry(JUMP_MOUNT_FRAMES));
            return;
        }
        stopFollowing();
        /**
         * Instant rather than smooth: a smooth scroll's first frames still sit within the follow threshold of the end,
         * so their scroll events would resume following and the next layout would pin the view straight back down.
         */
        const settle = (frames: number): void => {
            const top = Math.max(contentTop(view, element) - JUMP_MARGIN_PX, 0);
            if (Math.abs(view.scrollTop - top) > 1) view.scrollTo({ top });
            /**
             * Entries of history read back render at a placeholder height until they come near the view, so the ones
             * the jump brings into range resize and move the message; align again until they settle.
             */
            if (frames > 0) requestAnimationFrame(() => settle(frames - 1));
        };
        settle(JUMP_SETTLE_FRAMES);
    };
    const jumpTo = (id: string): void => align((content) => agentChatMessageElement(content, id));
    const jumpToTurn = (turnId: string): void =>
        align((content) => agentChatTurnStartElement(content, turnId));
    return { activeIndex, jumpTo, jumpToTurn };
}
