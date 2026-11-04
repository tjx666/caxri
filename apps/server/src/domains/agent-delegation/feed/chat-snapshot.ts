import type { AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatCurrentWork,
    agentChatWorkVerb,
    isAgentChatWorkItem,
    MAX_DELEGATION_STEP_LENGTH,
} from '@caxri/protocol';

import { clipToLength } from '../../agents';

/**
 * The part of a Chat's projection snapshot a Delegated Session's progress and failure details read.
 */
export type DelegationChatSnapshot = Pick<
    AgentChatSnapshot,
    'activeTurnId' | 'items' | 'historyId'
>;

/**
 * What the active turn of a delegated Chat is doing now, as one short label (`Running pnpm lint`, `Editing config.ts`),
 * or `undefined` while no turn runs or it has done no work yet. It uses the labels every Agent Chat Client shows for
 * the same work row (`describeAgentChatWork`), and between two calls it keeps naming the newest step, so the label does
 * not flicker to nothing each time a tool returns.
 *
 * The label can name a command or a file of the delegated work, so it is private domain data: it travels only to the
 * owner's windows and is never logged.
 */
export function delegationChatStep(
    snapshot: DelegationChatSnapshot | undefined,
): string | undefined {
    const turnId = snapshot?.activeTurnId;
    if (!snapshot || !turnId) return undefined;
    /**
     * Scan back from the newest item and stop at an earlier turn's item, so a long history costs only the active turn.
     */
    let start = snapshot.items.length;
    while (start > 0) {
        const previous = snapshot.items[start - 1].turnId;
        if (previous !== undefined && previous !== turnId) break;
        start -= 1;
    }
    const current = agentChatCurrentWork(snapshot.items.slice(start).filter(isAgentChatWorkItem));
    if (!current) return undefined;
    const { item, presentation } = current;
    const label = [agentChatWorkVerb(item, presentation), presentation.subject]
        .filter(Boolean)
        .join(' ')
        .replaceAll(/\s+/gu, ' ')
        .trim();
    return label ? clipToLength(label, MAX_DELEGATION_STEP_LENGTH) : undefined;
}

/**
 * When the provider said the usage limit that failed `turnId` resets, from the turn's `error` notice, or `undefined`
 * when the Chat has no such notice (the failure was not a plan limit, the provider named no time, or this Server Core
 * holds no projection for the Chat). The newest such notice wins.
 */
export function delegationUsageLimitResetsAt(
    snapshot: Pick<AgentChatSnapshot, 'items'> | undefined,
    turnId: string,
): number | undefined {
    const notice = snapshot?.items.findLast(
        (item) => item.type === 'notice' && item.turnId === turnId && item.usageLimit?.resetsAt,
    );
    return notice?.type === 'notice' ? notice.usageLimit?.resetsAt : undefined;
}
