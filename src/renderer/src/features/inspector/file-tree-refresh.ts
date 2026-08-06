import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey } from '../../state/queries';

/** Returns the directory whose listing directly owns a changed absolute path. */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator < 0) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}

/**
 * Invalidates only the `files.list` query cache entries a `files.changed` event actually touched.
 * An overflowed watcher batch invalidates every directory listed for the Session — the change set
 * was too large to enumerate — otherwise only the parent directory of each changed path is
 * invalidated, so an edit in one expanded directory never re-fetches a sibling.
 */
export function useFileTreeInvalidation(sessionId: string | undefined): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        if (!sessionId) return;
        return caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== sessionId) return;
            if (event.payload.overflow) {
                void queryClient.invalidateQueries({
                    predicate: (query) => {
                        const [method, params] = query.queryKey as [
                            string,
                            { sessionId?: string } | undefined,
                        ];
                        return method === 'files.list' && params?.sessionId === sessionId;
                    },
                });
                return;
            }
            const directories = new Set(
                event.payload.changes.map((change) => parentDirectoryPath(change.path)),
            );
            for (const directory of directories)
                void queryClient.invalidateQueries({
                    queryKey: caxriQueryKey('files.list', { sessionId, directory }),
                });
        });
    }, [sessionId, queryClient]);
}
