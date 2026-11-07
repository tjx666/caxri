import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import { scrollWithoutScrollbarFlash } from '../../../lib/quiet-scroll';
import { useSessionLookStore } from '../../session/session-look-boundary';
import { agentChatTurnStartElement } from '../rail/hooks/use-agent-chat-message-rail';
import {
    agentChatReturnAnchorTurnId,
    agentChatReturnHintSlotHeight,
    isAgentChatReturnAnchorAbove,
    isAgentChatReturnHintShown,
    turnsFinishedDuringAbsence,
} from '../transcript/agent-chat-return-boundary';
import { isScrolledToEnd } from './use-agent-chat-scroll';

export interface AgentChatReturnHintData {
    /**
     * Agent turns that finished while the user was away.
     */
    count: number;
    /**
     * The first missed turn, to jump to where it begins, when it is loaded.
     */
    anchorTurnId: string | undefined;
}

/**
 * Whether the opening entry of turn `anchorId` sits wholly above the scroll view (`isAgentChatReturnAnchorAbove`), so
 * the reader cannot see where the missed reply begins; checked on scroll and whenever the content or view resizes.
 * `undefined` while there is no anchor or it is not rendered.
 */
function useAgentChatAnchorAbove(
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
            const element = agentChatTurnStartElement(content, anchorId);
            setMeasured({
                anchorId,
                isAbove: element
                    ? isAgentChatReturnAnchorAbove(
                          element.getBoundingClientRect(),
                          view.getBoundingClientRect(),
                      )
                    : undefined,
            });
        };
        let frame: number | undefined;
        const schedule = (): void => {
            if (frame !== undefined) return;
            frame = requestAnimationFrame(() => {
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

/**
 * The "N turns since you last looked" hint for a Chat while it should show (`isAgentChatReturnHintShown`), or
 * `undefined` when the user did not just return to its Session, no turn finished while they were away, or the start of
 * what they missed is already in view.
 */
export function useAgentChatReturnHint(
    sessionId: string | undefined,
    snapshot: AgentChatSnapshot | undefined,
    olderItems: readonly AgentChatItem[],
    view: {
        scrollReference: RefObject<HTMLDivElement | null>;
        contentReference: RefObject<HTMLDivElement | null>;
        isLatestInView: boolean;
    },
): AgentChatReturnHintData | undefined {
    const window = useSessionLookStore((state) =>
        sessionId === undefined ? undefined : state.returns[sessionId],
    );
    const hint = useMemo(() => {
        if (!window || !snapshot) return;
        const count = turnsFinishedDuringAbsence(snapshot.turns, window).length;
        if (count === 0) return;
        return {
            count,
            anchorTurnId: agentChatReturnAnchorTurnId(
                [...olderItems, ...snapshot.items],
                snapshot.turns,
                window,
            ),
        };
    }, [olderItems, snapshot, window]);
    const isAnchorAbove = useAgentChatAnchorAbove(
        view.scrollReference,
        view.contentReference,
        hint?.anchorTurnId,
    );
    if (!hint) return undefined;
    const { isLatestInView } = view;
    return isAgentChatReturnHintShown({ count: hint.count, isAnchorAbove, isLatestInView })
        ? hint
        : undefined;
}

/**
 * Sizes the empty slot after the transcript that keeps the return hint off the last line
 * ({@link agentChatReturnHintSlotHeight}). The view keeps its size either way, so the hint showing or clearing never
 * clamps a view resting at its end: the slot holds the hint's room while it shows, and once it clears, scrolling back
 * consumes the slot and new content replaces it. The slot must sit directly in the scroll view, whose position it
 * measures against; the returned `onScroll` sizes it and then runs the view's own `onViewScroll`.
 */
export function useAgentChatReturnHintSlot(
    contentReference: RefObject<HTMLDivElement | null>,
    onViewScroll: () => void,
    { isShown }: { isShown: boolean },
): { slotReference: RefObject<HTMLDivElement | null>; onScroll: () => void } {
    const slotReference = useRef<HTMLDivElement | null>(null);
    const size = useCallback(() => {
        const slot = slotReference.current;
        const view = slot?.parentElement;
        if (!slot || !view) return;
        /**
         * Fractional rects, not `offsetTop`/`offsetHeight`/`clientHeight`: the rounded ones misplace the view's bottom
         * by a fraction of a pixel when its height is fractional.
         */
        const viewRect = view.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        const height = agentChatReturnHintSlotHeight({
            height: slotRect.height,
            isShown,
            slotTop: slotRect.top - viewRect.top + view.scrollTop,
            viewBottom: view.scrollTop + viewRect.height,
        });
        // Runs on every scroll event, so an unchanged height is not written back to invalidate layout.
        const next = `${height}px`;
        if (slot.style.height !== next) slot.style.height = next;
    }, [isShown]);
    useLayoutEffect(() => {
        const slot = slotReference.current;
        const view = slot?.parentElement;
        const content = contentReference.current;
        if (!slot || !view || !content) return;
        const wasAtEnd = isScrolledToEnd(view);
        size();
        if (isShown) {
            // The hint shows only at the latest entry; lift that entry above the hint instead of leaving it covered.
            if (wasAtEnd) scrollWithoutScrollbarFlash(view, view.scrollHeight - view.clientHeight);
            return;
        }
        // New content below the latest entry takes the slot's place, so a following view ends at the content again.
        let contentHeight = content.offsetHeight;
        const observer = new ResizeObserver(() => {
            if (content.offsetHeight > contentHeight) slot.style.height = '0px';
            contentHeight = content.offsetHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [contentReference, isShown, size]);
    const onScroll = useCallback(() => {
        size();
        onViewScroll();
    }, [onViewScroll, size]);
    return { slotReference, onScroll };
}
