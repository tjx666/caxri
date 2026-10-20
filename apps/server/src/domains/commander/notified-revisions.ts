/**
 * Cap on the notifier's remembered notified revisions: a long-running Server Core would otherwise keep one entry per
 * delegation ever notified. A duplicate `notifyReceiptChanged` for the same transition arrives within moments, so
 * evicting the least recently notified delegation past the cap never lets a live duplicate through.
 */
export const MAX_NOTIFIED_REVISIONS = 512;

/**
 * Records the newest notified `revision` for `delegationId` and evicts the least recently notified entries past
 * {@link MAX_NOTIFIED_REVISIONS}.
 */
export function rememberNotifiedRevision(
    notifiedRevisions: Map<string, number>,
    delegationId: string,
    revision: number,
): void {
    // Re-inserting moves the entry to the newest position, so eviction below drops the least recently notified.
    notifiedRevisions.delete(delegationId);
    notifiedRevisions.set(delegationId, revision);
    for (const oldest of notifiedRevisions.keys()) {
        if (notifiedRevisions.size <= MAX_NOTIFIED_REVISIONS) break;
        notifiedRevisions.delete(oldest);
    }
}
