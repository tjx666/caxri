/**
 * Cache identity of one Project search.
 *
 * `scopeId` is `sessionId:workbenchProjectId`, and both halves are load-bearing: the Server resolves the search against
 * the Session's currently authorized root, so a result must never be reused after that Session switches roots. The key
 * no longer names a view: the search moved out of the Files view container into its own overlay, so there is no view id
 * to scope it by, and the Session plus root is what the results actually belong to.
 */
export function projectSearchQueryKey(scopeId: string, options: Record<string, unknown>) {
    return ['files.search', scopeId, options] as const;
}
