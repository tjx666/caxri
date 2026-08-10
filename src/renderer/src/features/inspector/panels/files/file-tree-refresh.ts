import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { caxri } from '../../../../lib/caxri';
import { caxriQueryKey } from '../../../../queries/client';

/** Returns the directory whose listing directly owns a changed absolute path. */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator < 0) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}

/** True when one file change can alter ignored decoration below several expanded directories. */
export function affectsGitIgnoreRules(path: string): boolean {
    const normalized = path.replaceAll('\\', '/');
    return (
        normalized.endsWith('/.gitignore') ||
        normalized.endsWith('/.git/info/exclude') ||
        normalized.endsWith('/.git/config')
    );
}

/**
 * Invalidates only the `files.list` query cache entries a `files.changed` event actually touched.
 * An overflowed watcher batch or Git ignore-rule change invalidates every directory listed for the
 * Session — an ancestor rule can redecorate any expanded descendant. Other changes invalidate only
 * their direct parent, so an ordinary edit never re-fetches an unrelated sibling.
 */
export function useFileTreeInvalidation(sessionId: string | undefined): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        if (!sessionId) return;
        return caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== sessionId) return;
            if (
                event.payload.overflow ||
                event.payload.gitIgnoreRulesChanged ||
                event.payload.changes.some((change) => affectsGitIgnoreRules(change.path))
            ) {
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
