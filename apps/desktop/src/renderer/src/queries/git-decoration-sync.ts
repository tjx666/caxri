import { useEffect } from 'react';

import { setGitDecorationSummary } from '../stores/git-decorations';
import { useSelectedSession } from '../stores/selectors';
import { useCaxriQuery } from './client';

/**
 * The app's single subscriber to the selected Session's working-tree status, feeding `stores/git-decorations.ts`.
 *
 * Mounted once in `App` rather than by each decorated surface, so opening the Files view or a second split adds no
 * request. It joins the same `git.summary` query Source Control and the diff header already read, which is also what
 * makes the Server's `git.changed` invalidation (`./invalidation.ts`) refresh every decorated surface at once.
 * `git.overview` cannot serve this: it exists precisely to omit the per-file `files[]` payload decorations are made
 * of.
 */
export function useGitDecorationSync(): void {
    const session = useSelectedSession();
    const summary = useCaxriQuery(
        'git.summary',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session), retry: false, staleTime: 60_000 },
    ).data;
    useEffect(() => {
        setGitDecorationSummary(summary);
    }, [summary]);
}
