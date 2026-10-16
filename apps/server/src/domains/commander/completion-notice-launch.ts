import { logEventCatalog } from '@caxri/system';

import type { DeliveredNotice } from '../db';
import type { CommanderCompletionNotifierOptions } from './completion-notice';
import type {
    CommanderCompletionNoticeEntry,
    CommanderHandoverNoticeEntry,
    CommanderInboxNoticeEntry,
} from './notice-text';

/**
 * Exact queue revisions carried by one launch prompt, retained until that launch accepts it.
 */
export interface LaunchPromptClaim {
    /**
     * Newer turn markers belong to the new launch and must survive settlement.
     */
    claimedAt: number;
    delegations: Array<DeliveredNotice & CommanderCompletionNoticeEntry>;
    hasInterruptedTurn: boolean;
    inbox: Array<CommanderInboxNoticeEntry & { queuedAt: number }>;
    handovers: Array<CommanderHandoverNoticeEntry & { queuedAt: number }>;
    oldestQueuedAt: number;
    terminalId: string;
}

export function createCommanderLaunchClaim(
    options: CommanderCompletionNotifierOptions,
    terminalId: string,
    inbox: LaunchPromptClaim['inbox'],
    handovers: LaunchPromptClaim['handovers'],
    now: number,
): LaunchPromptClaim | undefined {
    const notices = options.database.commanderPendingNotices.list();
    if (notices.length === 0 && inbox.length === 0 && handovers.length === 0) return;
    return {
        claimedAt: now,
        delegations: notices.filter((notice) => notice.kind === 'delegation'),
        hasInterruptedTurn: notices.some((notice) => notice.kind === 'interrupted_turn'),
        inbox,
        handovers,
        oldestQueuedAt: Math.min(
            ...[...notices, ...inbox, ...handovers].map((notice) => notice.queuedAt),
        ),
        terminalId,
    };
}

/**
 * Removes only the claimed entries, so transitions arriving during startup remain owed.
 */
export function settleCommanderLaunchClaim({
    claim,
    options,
    pendingInbox,
    pendingHandovers,
    now,
    shouldClearInterruptedTurn = true,
}: {
    claim: LaunchPromptClaim;
    options: Pick<CommanderCompletionNotifierOptions, 'database' | 'logger'>;
    pendingInbox: Map<string, CommanderInboxNoticeEntry & { queuedAt: number }>;
    pendingHandovers: Map<string, CommanderHandoverNoticeEntry & { queuedAt: number }>;
    now: number;
    shouldClearInterruptedTurn?: boolean;
}): void {
    const store = options.database.commanderPendingNotices;
    store.removeDelegations(claim.delegations);
    if (shouldClearInterruptedTurn && claim.hasInterruptedTurn) store.clearTurn(claim.claimedAt);
    for (const entry of claim.inbox)
        if (pendingInbox.get(entry.itemId) === entry) pendingInbox.delete(entry.itemId);
    for (const entry of claim.handovers)
        if (pendingHandovers.get(entry.handoverId) === entry)
            pendingHandovers.delete(entry.handoverId);
    options.logger?.write('info', logEventCatalog.agentCommander.resumePromptDelivered, {
        fields: {
            count: claim.delegations.length,
            inboxCount: claim.inbox.length,
            handoverCount: claim.handovers.length,
            interruptedTurn: claim.hasInterruptedTurn,
            waitMs: Math.max(0, now - claim.oldestQueuedAt),
        },
    });
}
