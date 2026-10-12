import { useMemo } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type { AgentChatOlderHistory } from '../agent-chat-history';
import { splitAgentChatHistory } from '../agent-chat-history';
import type { AgentChatRailMark } from '../agent-chat-rail-marks';
import { agentChatRailMarks, sampleAgentChatRailMarks } from '../agent-chat-rail-marks';
import type { AgentChatSettledChunk } from '../agent-chat-settled-chunks';
import { agentChatSettledChunks } from '../agent-chat-settled-chunks';
import { agentChatDayBreaks } from '../agent-chat-time';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import { buildAgentChatTimeline } from '../agent-chat-timeline';

/**
 * What a Chat pane renders: the history read back as settled chunks, the live timeline after it, and the day breaks and
 * rail marks that span both.
 */
export function useAgentChatTimelines(
    snapshot: AgentChatSnapshot | undefined,
    history: AgentChatOlderHistory,
): {
    settledChunks: readonly AgentChatSettledChunk[];
    timeline: AgentChatTimelineEntry[];
    dayBreaks: ReturnType<typeof agentChatDayBreaks>;
    railMarks: readonly AgentChatRailMark[];
} {
    const items = snapshot?.items;
    const turns = snapshot?.turns;
    const activeTurnId = snapshot?.activeTurnId;
    const { items: olderItems, turns: olderTurns } = history;
    const liveTurnId = items?.[0]?.turnId;
    const { settled, carried } = useMemo(
        () => splitAgentChatHistory(olderItems, liveTurnId),
        [olderItems, liveTurnId],
    );
    /**
     * History read back renders apart from the live projection: it never changes while the conversation streams, so a
     * patch rebuilds and reconciles only the live part however far back the reader went.
     */
    const settledChunks = useMemo(
        () => agentChatSettledChunks(settled, olderTurns),
        [settled, olderTurns],
    );
    const timeline = useMemo(() => {
        if (!items || !turns) return [];
        if (carried.length === 0) return buildAgentChatTimeline(items, turns, activeTurnId);
        const carriedTurn = olderTurns.find((turn) => turn.id === liveTurnId);
        return buildAgentChatTimeline(
            [...carried, ...items],
            carriedTurn && turns.every((turn) => turn.id !== liveTurnId)
                ? [carriedTurn, ...turns]
                : turns,
            activeTurnId,
        );
    }, [items, turns, activeTurnId, carried, olderTurns, liveTurnId]);
    const dayBreaks = useMemo(
        () =>
            agentChatDayBreaks(
                timeline,
                settledChunks.findLast((chunk) => chunk.lastDay !== undefined)?.lastDay,
            ),
        [timeline, settledChunks],
    );
    const railMarks = useMemo(
        () =>
            sampleAgentChatRailMarks(
                agentChatRailMarks([
                    ...settledChunks.flatMap((chunk) => chunk.entries),
                    ...timeline,
                ]),
            ),
        [settledChunks, timeline],
    );
    return { settledChunks, timeline, dayBreaks, railMarks };
}
