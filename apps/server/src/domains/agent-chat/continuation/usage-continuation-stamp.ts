import type {
    AgentChatAutoContinue,
    AgentChatContinuation,
    AgentChatItem,
    AgentChatPatchOperation,
} from '@caxri/protocol';

/**
 * Stamps each usage-limit notice with where another Agent continued its turn, from the continuation's own delegation
 * record, so a history replay keeps the link, and with the Chat's own automatic continuation of it
 * (`ChatUsageLimitWaits`), which replaces whatever the notice carried before.
 */
export function stampUsageContinuations(
    operations: readonly AgentChatPatchOperation[],
    continuedIn: (turnId: string) => AgentChatContinuation | undefined,
    autoContinue: (turnId: string) => AgentChatAutoContinue | undefined = () => {},
): readonly AgentChatPatchOperation[] {
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const { item } = operation;
        if (item.type !== 'notice' || !item.usageLimit || !item.turnId) continue;
        const continuation = item.usageLimit.continuedIn ?? continuedIn(item.turnId);
        const automatic = autoContinue(item.turnId);
        if (
            continuation === item.usageLimit.continuedIn &&
            automatic === item.usageLimit.autoContinue
        )
            continue;
        const usageLimit = { ...item.usageLimit };
        delete usageLimit.autoContinue;
        stamped ??= [...operations];
        stamped[index] = {
            op: 'upsertItem',
            item: {
                ...item,
                usageLimit: {
                    ...usageLimit,
                    ...(continuation && { continuedIn: continuation }),
                    ...(automatic && { autoContinue: automatic }),
                },
            },
        };
    }
    return stamped ?? operations;
}

/**
 * What a Chat's projection tells its automatic continuation (`ChatUsageLimitWaits`), bound to its Terminal.
 */
export interface ProjectionUsageLimitWaits {
    stateOf(turnId: string): AgentChatAutoContinue | undefined;
    observeFailure(notice: UsageLimitNotice): void;
    replayNotice(): UsageLimitNotice | undefined;
}

export type UsageLimitNotice = Extract<AgentChatItem, { type: 'notice' }> & {
    usageLimit: NonNullable<Extract<AgentChatItem, { type: 'notice' }>['usageLimit']>;
};

/**
 * Reports each usage-limit notice a live batch brings to the Chat's automatic continuation, and puts back on a history
 * replay the notice of a wait the provider's record does not keep, as the newest item.
 */
export function observeUsageLimitWaits(
    operations: readonly AgentChatPatchOperation[],
    isHistoryReplay: boolean,
    waits: ProjectionUsageLimitWaits | undefined,
): readonly AgentChatPatchOperation[] {
    if (!waits) return operations;
    if (isHistoryReplay) {
        const notice = waits.replayNotice();
        if (!notice) return operations;
        const isKept = operations.some(
            (operation) => operation.op === 'upsertItem' && operation.item.id === notice.id,
        );
        return isKept ? operations : [...operations, { op: 'upsertItem', item: notice }];
    }
    for (const operation of operations) {
        if (operation.op !== 'upsertItem') continue;
        const { item } = operation;
        if (item.type === 'notice' && item.kind === 'error' && item.usageLimit && item.turnId)
            waits.observeFailure(item as UsageLimitNotice);
    }
    return operations;
}
