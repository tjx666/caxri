import { useMemo } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import { useSessionLookStore } from '../../session/session-look-boundary';
import {
    agentChatReturnAnchorId,
    turnsFinishedDuringAbsence,
} from '../transcript/agent-chat-return-boundary';

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
 * The "N turns since you last looked" hint for a Chat, or `undefined` when the user did not just return to its Session
 * or nothing finished while they were away.
 */
export function useAgentChatReturnHint(
    sessionId: string | undefined,
    snapshot: AgentChatSnapshot | undefined,
    olderItems: readonly AgentChatItem[],
): AgentChatReturnHintData | undefined {
    const window = useSessionLookStore((state) =>
        sessionId === undefined ? undefined : state.returns[sessionId],
    );
    return useMemo(() => {
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
}
