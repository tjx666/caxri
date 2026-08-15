import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { caxri } from '../../../../lib/caxri';
import { caxriQueryKey } from '../../../../queries/client';
import { getWorkbenchProjectSessionIds } from '../../../../stores/selectors';

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
export function useFileTreeQueryInvalidation(): void {
    const queryClient = useQueryClient();
    useEffect(() => subscribeFileTreeInvalidation(queryClient), [queryClient]);
}

/** Invalidates current Workbench Project tree queries, including inactive sibling Sessions. */
export function subscribeFileTreeInvalidation(
    queryClient: ReturnType<typeof useQueryClient>,
): () => void {
    return caxri.onEvent((event) => {
        if (event.event !== 'files.changed') return;
        const sessionIds = getWorkbenchProjectSessionIds(
            event.payload.workbenchProjectId,
            event.payload.sessionId,
        );
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
                    return (
                        method === 'files.list' &&
                        params?.sessionId !== undefined &&
                        sessionIds.includes(params.sessionId)
                    );
                },
            });
            return;
        }
        const directories = new Set(
            event.payload.changes.map((change) => parentDirectoryPath(change.path)),
        );
        for (const sessionId of sessionIds)
            for (const directory of directories)
                void queryClient.invalidateQueries({
                    queryKey: caxriQueryKey('files.list', { sessionId, directory }),
                });
    });
}
