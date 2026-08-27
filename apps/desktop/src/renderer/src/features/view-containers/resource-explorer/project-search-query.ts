import { controlledViewQueryKey } from '../view-operation-client';

/**
 * Search results belong to the Session and its selected Workbench Root. Keeping both in the cache key prevents a result
 * from one authorized root being reused after the same Session switches roots.
 */
export function projectSearchQueryKey(
    viewId: string,
    options: Record<string, unknown>,
    scopeId: string,
) {
    return controlledViewQueryKey(viewId, 'files.search', options, scopeId);
}
