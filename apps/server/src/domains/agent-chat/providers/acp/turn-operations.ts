import type {
    AgentChatImageInput,
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatUsageLimit,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, closeDanglingItem } from '../../chat-items';
import type { ChatLifecycleEvent } from '../../chat-provider';

/**
 * The pure pieces of an ACP turn: the content blocks a `session/prompt` carries, and the projection items and
 * operations a turn's prompts, proposed plan, and end produce. `AcpChatSession` owns when they apply.
 */

export type AcpPromptBlock =
    { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };

/**
 * A prompt's content blocks: the text first when there is any, then each image.
 */
export function promptBlocks(
    text: string,
    images: readonly AgentChatImageInput[],
): AcpPromptBlock[] {
    return [
        ...(text || images.length === 0 ? [{ type: 'text' as const, text }] : []),
        ...images.map((image) => ({
            type: 'image' as const,
            mimeType: image.mediaType,
            data: image.data,
        })),
    ];
}

/**
 * The user message a prompt shows, with the Client's image thumbnails, never the images themselves.
 */
export function userMessageItem(
    id: string,
    turnId: string,
    text: string,
    images: readonly AgentChatImageInput[],
    delivery: Extract<AgentChatItem, { type: 'userMessage' }>['delivery'],
): AgentChatItem {
    return {
        id,
        turnId,
        type: 'userMessage',
        text: clip(text, MAX_AGENT_CHAT_TEXT_LENGTH),
        ...(images.length > 0 && {
            images: images.map((image) => ({ thumbnail: image.thumbnail })),
        }),
        ...(delivery && { delivery }),
    };
}

/**
 * The proposed-plan reply a plan-mode tool call's plan shows as, which `agentChat.implementPlan` builds from.
 */
export function proposedPlanItem(callId: string, turnId: string, plan: string): AgentChatItem {
    return {
        id: clip(`${callId}:plan`, 200),
        turnId,
        type: 'agentMessage',
        text: clip(plan, MAX_AGENT_CHAT_TEXT_LENGTH),
        streaming: false,
        proposedPlan: true,
    };
}

/**
 * How a `session/prompt` ended, beyond its status: its result, or the error it failed with and any used-up limit.
 */
export interface AcpTurnDetails {
    result?: unknown;
    error?: string;
    usageLimit?: AgentChatUsageLimit | undefined;
}

export interface AcpTurnEnd {
    turnId: string;
    status: AgentChatTurn['status'];
    durationMs: number;
    isCompaction: boolean;
    error?: string;
    usageLimit?: AgentChatUsageLimit | undefined;
    usage?: AgentChatSnapshot['usage'];
}

/**
 * What ending a turn applies: its dangling items closed, an error notice carrying any used-up limit, a compaction
 * notice, and the turn's status, duration, and usage.
 */
export function finishedTurnOperations(
    snapshot: AgentChatSnapshot,
    end: AcpTurnEnd,
): AgentChatPatchOperation[] {
    const { turnId, status, durationMs, usage } = end;
    const operations: AgentChatPatchOperation[] = [];
    for (const item of snapshot.items) {
        if (item.turnId !== turnId) continue;
        const closed = closeDanglingItem(item);
        if (closed) operations.push({ op: 'upsertItem', item: closed });
    }
    if (end.error)
        operations.push({
            op: 'upsertItem',
            item: {
                id: `${turnId}:error`,
                turnId,
                type: 'notice',
                kind: 'error',
                message: clip(end.error, 2_000),
                ...(end.usageLimit && { usageLimit: end.usageLimit }),
            },
        });
    if (status === 'completed' && end.isCompaction)
        operations.push({
            op: 'upsertItem',
            item: { id: `${turnId}:compacted`, turnId, type: 'notice', kind: 'compacted' },
        });
    operations.push({
        op: 'state',
        state: {
            turns: snapshot.turns.map((existing) =>
                existing.id === turnId ? { ...existing, status, durationMs } : existing,
            ),
            activeTurnId: null,
            ...(usage && { usage }),
        },
    });
    return operations;
}

/**
 * Puts the window and reset time a quota reading names on the usage-limit notice `turnId` failed with, which ended
 * without one so the turn never waited on the reading (issue #4114). Nothing changes when the reading names none, or
 * when a later turn started meanwhile: the Chat moved on, and a refined notice would plan a wait for an old turn.
 */
export function refinedUsageLimitOperations(
    snapshot: AgentChatSnapshot,
    turnId: string,
    usageLimit: AgentChatUsageLimit,
): AgentChatPatchOperation[] {
    if (usageLimit.window === 'unknown' && usageLimit.resetsAt === undefined) return [];
    if (snapshot.turns.at(-1)?.id !== turnId) return [];
    const notice = snapshot.items.find((item) => item.id === `${turnId}:error`);
    if (notice?.type !== 'notice' || !notice.usageLimit) return [];
    const refined = { ...notice.usageLimit, ...usageLimit };
    return [{ op: 'upsertItem', item: { ...notice, usageLimit: refined } }];
}

/**
 * The lifecycle event a turn's end reports. A used-up plan limit is the lifecycle's quota failure, as for a Claude Code
 * Chat.
 */
export function finishedTurnEvent(
    agentSessionId: string,
    end: Pick<AcpTurnEnd, 'turnId' | 'status' | 'usageLimit'>,
): ChatLifecycleEvent {
    const agentTurnId = end.turnId;
    if (end.status !== 'failed') return { phase: 'turnFinished', agentSessionId, agentTurnId };
    return {
        phase: 'turnFailed',
        agentSessionId,
        agentTurnId,
        agentFailure: end.usageLimit ? 'billing_error' : 'provider_failed',
    };
}
