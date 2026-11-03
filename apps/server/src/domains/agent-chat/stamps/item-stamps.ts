import type { AgentChatPatchOperation, AgentChatSnapshot, AgentChatTurn } from '@caxri/protocol';

/**
 * Stamps `createdAt` on each item that enters the projection live, so the transcript can say when a message was sent or
 * answered. Every provider rebuilds history as one batch led by `reset`, and an item after that `reset` is a replay
 * whose real time is long past: it keeps whatever time its provider recorded, or none, rather than the time of the
 * replay. Later upserts of a stamped item inherit the stamp in the shared reducer.
 */
export function stampNewItems(
    snapshot: AgentChatSnapshot,
    operations: readonly AgentChatPatchOperation[],
    now: number,
): readonly AgentChatPatchOperation[] {
    if (operations.some((operation) => operation.op === 'reset')) return operations;
    const known = new Set(snapshot.items.map((item) => item.id));
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const { item } = operation;
        if (item.createdAt === undefined && !known.has(item.id)) {
            stamped ??= [...operations];
            stamped[index] = { op: 'upsertItem', item: { ...item, createdAt: now } };
        }
        known.add(item.id);
    }
    return stamped ?? operations;
}

/**
 * Names who stopped each interrupted turn Caxri was asked to stop. No provider reports who interrupted a turn, so the
 * Server Core that relayed the Stop remembers it by turn id and stamps it whenever that turn arrives `interrupted`,
 * including in a later history replay of the same Chat.
 */
export function stampStoppedTurns(
    operations: readonly AgentChatPatchOperation[],
    stops: ReadonlyMap<string, NonNullable<AgentChatTurn['stoppedBy']>>,
): readonly AgentChatPatchOperation[] {
    if (stops.size === 0) return operations;
    return operations.map((operation) => {
        if (operation.op !== 'state' || !operation.state.turns) return operation;
        const original = operation.state.turns;
        const turns = original.map((turn) => {
            const stoppedBy = stops.get(turn.id);
            if (!stoppedBy || turn.status !== 'interrupted' || turn.stoppedBy === stoppedBy)
                return turn;
            return { ...turn, stoppedBy };
        });
        return turns.some((turn, index) => turn !== original[index])
            ? { ...operation, state: { ...operation.state, turns } }
            : operation;
    });
}
