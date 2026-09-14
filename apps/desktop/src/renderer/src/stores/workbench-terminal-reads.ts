import type { TerminalRecord } from '@caxri/protocol';

/**
 * Per-Terminal request ordering for the two read paths that can overlap: full `app.bootstrap` and targeted
 * `app.records`. One monotonic counter timestamps request issuance, while `appliedById` keeps the latest successfully
 * applied read for each affected Terminal. Entries retire as soon as no older request can still resolve, so deleted
 * Terminal IDs cannot accumulate as permanent tombstones.
 */
const terminalReads = {
    active: new Map<number, ReadonlySet<string>>(),
    appliedById: new Map<string, number>(),
    sent: 0,
};

export function beginTerminalRead(terminalIds: ReadonlySet<string> = new Set()): number {
    terminalReads.sent += 1;
    terminalReads.active.set(terminalReads.sent, new Set(terminalIds));
    return terminalReads.sent;
}

export function finishTerminalRead(readSequence: number): void {
    terminalReads.active.delete(readSequence);
    const oldestActiveSequence = Math.min(...terminalReads.active.keys());
    for (const [terminalId, appliedSequence] of terminalReads.appliedById)
        if (oldestActiveSequence >= appliedSequence) terminalReads.appliedById.delete(terminalId);
}

function isCurrentTerminalRead(terminalId: string, readSequence: number): boolean {
    return (terminalReads.appliedById.get(terminalId) ?? -1) <= readSequence;
}

/**
 * Narrows a read's Terminal IDs to the ones it is still the newest read for, and records it as their latest applied
 * read. Callers apply exactly the returned IDs, so an older response can never roll `dead` back to `running` or
 * resurrect a Terminal a newer targeted read already deleted.
 */
export function acceptTerminalReads(
    terminalIds: Iterable<string>,
    readSequence: number,
): Set<string> {
    const accepted = new Set<string>();
    for (const terminalId of terminalIds) {
        if (!isCurrentTerminalRead(terminalId, readSequence)) continue;
        accepted.add(terminalId);
        terminalReads.appliedById.set(terminalId, readSequence);
    }
    return accepted;
}

export function replaceRequestedRecords<Record extends { id: string }>(
    current: readonly Record[],
    requestedIds: ReadonlySet<string>,
    updates: readonly Record[],
): Record[] {
    const updatesById = new Map(updates.map((record) => [record.id, record]));
    const currentIds = new Set(current.map((record) => record.id));
    return [
        ...current.flatMap((record) => {
            if (!requestedIds.has(record.id)) return [record];
            const update = updatesById.get(record.id);
            return update ? [update] : [];
        }),
        ...updates.filter((record) => !currentIds.has(record.id)),
    ];
}

/**
 * Applies every Terminal in a full snapshot except IDs already covered by a newer successful targeted read. The current
 * record (or its absence) is preserved for those IDs, so an older bootstrap cannot roll `dead` back to `running` or
 * resurrect a targeted deletion.
 */
export function applyFullTerminalSnapshot(
    current: readonly TerminalRecord[],
    incoming: readonly TerminalRecord[],
    readSequence: number,
): TerminalRecord[] {
    const currentIds = new Set(current.map((terminal) => terminal.id));
    const candidateIds = new Set([
        ...currentIds,
        ...incoming.map((terminal) => terminal.id),
        ...terminalReads.appliedById.keys(),
    ]);
    for (const terminalIds of terminalReads.active.values())
        for (const terminalId of terminalIds) candidateIds.add(terminalId);
    const authoritativeIds = acceptTerminalReads(candidateIds, readSequence);
    const safeIncoming = incoming.filter(
        (terminal) => authoritativeIds.has(terminal.id) || currentIds.has(terminal.id),
    );
    return replaceRequestedRecords(current, authoritativeIds, safeIncoming);
}
