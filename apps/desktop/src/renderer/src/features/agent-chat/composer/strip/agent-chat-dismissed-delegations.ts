import { createSharedLocalState } from '../../../../lib/local-storage';
import { createStore } from '../../../../lib/store';

/**
 * Device-local key for the delegated rows the user dismissed from a Chat's Background work list. Presentation state of
 * this window profile (docs/client-local-data.md): the Session itself stays in the sidebar, and no other client reads
 * the list, so it never reaches Server Core.
 */
const DISMISSED_DELEGATIONS_STORAGE_KEY = 'caxri.agentChatDismissedDelegations.v1';

/**
 * Bound on the stored ids, newest kept: a dismissed task older than this many dismissals has long left every list.
 */
export const MAX_DISMISSED_DELEGATIONS = 500;

/**
 * Reads the stored ids, dropping anything that is not a non-empty string, oldest first.
 */
export function parseDismissedDelegations(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * `stored` with `ids` appended (each id once, a repeated one moved to the newest end), cut to the newest
 * {@link MAX_DISMISSED_DELEGATIONS}.
 */
export function withDismissedDelegations(
    stored: readonly string[],
    ids: readonly string[],
): string[] {
    const added = new Set(ids);
    return [...stored.filter((id) => !added.has(id)), ...added].slice(-MAX_DISMISSED_DELEGATIONS);
}

const storage = createSharedLocalState(
    DISMISSED_DELEGATIONS_STORAGE_KEY,
    parseDismissedDelegations,
);

interface DismissedDelegationsState {
    /**
     * Every dismissed delegated row's id (`delegatedBackgroundItemId`), across Chats: the id names the task, which
     * belongs to one Chat.
     */
    dismissed: ReadonlySet<string>;
}

/**
 * Survives a restart, unlike the window-lifetime dismissals of background tasks (`agent-chat-seen-failures.ts`): a
 * delegated failure or interruption stays in the delegation feed, so a list that forgot its dismissals refilled with
 * every one of them after each restart. Follows the other windows of the profile.
 */
const useDismissedDelegationsStore = createStore<DismissedDelegationsState>(
    'agentChatDismissedDelegations',
    (set) => {
        storage.subscribe((ids) => set({ dismissed: new Set(ids) }));
        return { dismissed: new Set(storage.read()) };
    },
);

/**
 * Dismisses delegated rows from every Chat's list, now and after a restart.
 */
export function dismissDelegatedBackgroundItems(ids: readonly string[]): void {
    if (ids.length === 0) return;
    // Re-read at write time, so a dismissal another window made meanwhile survives.
    const next = withDismissedDelegations(storage.read(), ids);
    storage.write(next);
    useDismissedDelegationsStore.setState({ dismissed: new Set(next) });
}

export function useDismissedDelegations(): ReadonlySet<string> {
    return useDismissedDelegationsStore(({ dismissed }) => dismissed);
}
