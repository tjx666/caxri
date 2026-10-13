import { createHash } from 'node:crypto';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

/**
 * The digest a Chat lifecycle signal carries for a prompt or an answer: SHA-256 over the exact UTF-8 text, the same
 * hashing Agent delegation applies to its task pointer, so a delegated Chat turn correlates with its task.
 */
export function chatTextDigest(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * The last assistant message a turn produced, which is the turn's answer.
 */
export function chatTurnFinalMessage(
    snapshot: Pick<AgentChatSnapshot, 'items'>,
    turnId: string,
): { id: string; text: string } | undefined {
    const message = snapshot.items.findLast(
        (item) => item.type === 'agentMessage' && item.turnId === turnId,
    );
    return message?.type === 'agentMessage' ? { id: message.id, text: message.text } : undefined;
}

/**
 * What a Chat's in-memory projection knows about one turn, for Agent delegation's answer collection:
 *
 * - `unavailable`: this Server Core holds no projection for the Chat (it closed, or Server Core restarted).
 * - `missing`: the projection has no such turn.
 * - `running`: the turn has not ended.
 * - `finished`: the turn ended with `status`; `answer` is its final assistant message, absent when it wrote none, and
 *   `isTruncated` marks an answer cut at the projection's text bound.
 */
export type ChatTurnAnswer =
    | { status: 'unavailable' | 'missing' | 'running' }
    | {
          status: 'finished';
          outcome: 'completed' | 'interrupted' | 'failed';
          answer?: { id: string; text: string };
          isTruncated: boolean;
      };

export function chatTurnAnswer(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> | undefined,
    turnId: string,
): ChatTurnAnswer {
    if (!snapshot) return { status: 'unavailable' };
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    if (!turn) return { status: 'missing' };
    if (turn.status === 'running' || snapshot.activeTurnId === turnId) return { status: 'running' };
    const answer = chatTurnFinalMessage(snapshot, turnId);
    return {
        status: 'finished',
        outcome: turn.status,
        ...(answer && { answer }),
        isTruncated: (answer?.text.length ?? 0) >= MAX_AGENT_CHAT_TEXT_LENGTH,
    };
}
