import type { AgentChatContinuation, AgentChatPatchOperation } from '@caxri/protocol';

/**
 * Stamps `continuedIn` on each usage-limit notice whose turn another Agent continued, from the continuation's own
 * delegation record, so a history replay keeps the link.
 */
export function stampUsageContinuations(
    operations: readonly AgentChatPatchOperation[],
    continuedIn: (turnId: string) => AgentChatContinuation | undefined,
): readonly AgentChatPatchOperation[] {
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const { item } = operation;
        if (item.type !== 'notice' || !item.usageLimit) continue;
        if (item.usageLimit.continuedIn) continue;
        const continuation = item.turnId ? continuedIn(item.turnId) : undefined;
        if (!continuation) continue;
        stamped ??= [...operations];
        stamped[index] = {
            op: 'upsertItem',
            item: { ...item, usageLimit: { ...item.usageLimit, continuedIn: continuation } },
        };
    }
    return stamped ?? operations;
}
