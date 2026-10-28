export type QueryScreenKind = 'empty' | 'error' | 'loading' | 'offline' | 'ready';

/**
 * Which state a screen that reads one list from the computer draws. Such a query is disabled while the phone cannot
 * observe the computer (offline, backgrounded, reconnecting), and a disabled query stays `pending` with an idle fetch,
 * so "pending and not fetching" is offline rather than an endless spinner. A list already read stays on screen.
 */
export const queryScreenKind = ({
    fetchStatus,
    hasData,
    isError,
    itemCount,
}: {
    fetchStatus: 'fetching' | 'idle' | 'paused';
    hasData: boolean;
    isError: boolean;
    itemCount: number;
}): QueryScreenKind => {
    if (hasData) return itemCount > 0 ? 'ready' : 'empty';
    if (isError) return 'error';
    return fetchStatus === 'fetching' ? 'loading' : 'offline';
};
