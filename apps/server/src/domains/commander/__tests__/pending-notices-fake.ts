import type { CommanderPendingNotice, DeliveredNotice } from '../../db';

/**
 * In-memory stand-in for `CommanderPendingNoticesModel` with the same keying: one row per delegation and one
 * interrupted-turn marker. The model's SQL is covered by its own integration test.
 */
export function pendingStore() {
    const rows = new Map<string, CommanderPendingNotice>();
    return {
        rows,
        list: () =>
            rows
                .values()
                .toArray()
                .toSorted((left, right) => left.queuedAt - right.queuedAt),
        putDelegation(
            notice: Omit<Extract<CommanderPendingNotice, { kind: 'delegation' }>, 'kind'>,
        ) {
            const key = `delegation:${notice.delegationId}`;
            const existing = rows.get(key);
            rows.set(key, {
                kind: 'delegation',
                ...notice,
                queuedAt: existing?.queuedAt ?? notice.queuedAt,
            });
        },
        markTurnStarted(now: number) {
            rows.set('interrupted_turn', { kind: 'interrupted_turn', queuedAt: now });
        },
        clearTurn(startedBy?: number) {
            const marker = rows.get('interrupted_turn');
            if (marker && (startedBy === undefined || marker.queuedAt <= startedBy))
                rows.delete('interrupted_turn');
        },
        removeDelegations(delivered: readonly DeliveredNotice[]) {
            for (const { delegationId, revision } of delivered) {
                const key = `delegation:${delegationId}`;
                const row = rows.get(key);
                if (row?.kind === 'delegation' && row.revision === revision) rows.delete(key);
            }
        },
    };
}
