import type { RefObject } from 'react';
import { useMemo } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import { useSessionLookStore } from '../../session/session-look-boundary';
import {
    agentChatReturnAnchorId,
    isAgentChatReturnHintShown,
    turnsFinishedDuringAbsence,
} from '../transcript/agent-chat-return-boundary';
import { useAgentChatAnchorAbove } from './use-agent-chat-anchor-above';

export interface AgentChatReturnHintData {
    /**
     * Agent turns that finished while the user was away.
     */
    count: number;
    /**
     * The prompt to jump to, when it is loaded.
     */
    anchorId: string | undefined;
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
            anchorId: agentChatReturnAnchorId(
                [...olderItems, ...snapshot.items],
                snapshot.turns,
                window,
            ),
        };
    }, [olderItems, snapshot, window]);
    const isAnchorAbove = useAgentChatAnchorAbove(
        view.scrollReference,
        view.contentReference,
        hint?.anchorId,
    );
    if (!hint) return undefined;
    const { isLatestInView } = view;
    return isAgentChatReturnHintShown({ count: hint.count, isAnchorAbove, isLatestInView })
        ? hint
        : undefined;
}
