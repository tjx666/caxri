import type { RefObject } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import { useSessionLookStore } from '../../session/session-look-boundary';
import { agentChatTurnStartElement } from '../rail/hooks/use-agent-chat-message-rail';
import {
    agentChatReturnAnchorTurnId,
    isAgentChatReturnAnchorAbove,
    isAgentChatReturnHintShown,
    turnsFinishedDuringAbsence,
} from '../transcript/agent-chat-return-boundary';

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
