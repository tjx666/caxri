import { MAX_DELEGATION_STATUS_IDS } from '@caxri/protocol';

/**
 * The task IDs to ask `agent.delegation.statuses` about, as the read's ID lists: the distinct IDs, sorted (code-point
 * order, independent of the locale) so the same set always produces the same query keys, in chunks of the most IDs one
 * read accepts. An empty set yields no chunk, so no read is made.
 */
export function delegationStatusIdChunks(delegationIds: readonly string[]): string[][] {
    const sorted = [...new Set(delegationIds)].toSorted(
        (left, right) => Number(left > right) - Number(left < right),
    );
    const chunks: string[][] = [];
    for (let start = 0; start < sorted.length; start += MAX_DELEGATION_STATUS_IDS)
        chunks.push(sorted.slice(start, start + MAX_DELEGATION_STATUS_IDS));
    return chunks;
}
