import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';

/**
 * The window of time the user was away from a Session: `boundary` is when they last looked at it, `capturedAt` is when
 * they came back. Turns that finish after `capturedAt` happen in front of the user and are not "new" to them.
 */
export interface AgentChatReturnWindow {
    boundary: number;
    capturedAt: number;
}

/**
 * When a turn ended, or `undefined` while it runs or when the provider reported no timing (replayed history).
 */
function turnEndedAt(turn: AgentChatTurn): number | undefined {
    if (turn.status === 'running') return undefined;
    if (turn.startedAt === undefined || turn.durationMs === undefined) return undefined;
    return turn.startedAt + turn.durationMs;
}

/**
 * The Agent turns that finished while the user was away, in snapshot order. A turn counts by its own end time, never by
 * the Session's attention epoch, which also moves for a permission request or a question within one turn.
 */
export function turnsFinishedDuringAbsence(
    turns: readonly AgentChatTurn[],
    window: AgentChatReturnWindow,
): AgentChatTurn[] {
    return turns.filter((turn) => {
        const endedAt = turnEndedAt(turn);
        return endedAt !== undefined && endedAt > window.boundary && endedAt <= window.capturedAt;
    });
}

/**
 * The prompt that opened the first turn the user missed, to jump to; `undefined` when no turn was missed or its prompt
 * is not among the loaded items.
 */
export function agentChatReturnAnchorId(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    window: AgentChatReturnWindow,
): string | undefined {
    const first = turnsFinishedDuringAbsence(turns, window).at(0);
    if (!first) return undefined;
    return items.find((item) => item.type === 'userMessage' && item.turnId === first.id)?.id;
}
