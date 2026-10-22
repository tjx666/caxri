import { useEffect } from 'react';

import type { GitSummary } from '@caxri/protocol';

import { setGitDecorationSummary } from '../stores/git-decorations';
import { useSelectedSessionId } from '../stores/selectors';
import { useCaxriQuery } from './client';

export type GitDecorationSummaryUpdate =
    { kind: 'keep' } | { kind: 'replace'; summary: GitSummary | undefined };

/**
 * Session switches change the `git.summary` query key, so the next snapshot is `undefined` until it arrives. Writing
 * that gap into the decoration store flashes every file letter empty. Keep the last summary while a Session is still
 * selected; clear only when there is no Session.
 */
export function gitDecorationSummaryUpdate(
    hasSession: boolean,
    summary: GitSummary | undefined,
): GitDecorationSummaryUpdate {
    if (!hasSession) return { kind: 'replace', summary: undefined };
    if (summary === undefined) return { kind: 'keep' };
    return { kind: 'replace', summary };
}

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
    const sessionId = useSelectedSessionId();
    const summary = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId), retry: false, staleTime: 60_000 },
    ).data;
    useEffect(() => {
        const update = gitDecorationSummaryUpdate(Boolean(sessionId), summary);
        if (update.kind === 'keep') return;
        setGitDecorationSummary(update.summary);
    }, [sessionId, summary]);
}
