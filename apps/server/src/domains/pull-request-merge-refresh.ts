import type { SessionPullRequestService } from './project-status';

/**
 * Re-resolves the Session rows that show pull request `number` right after Caxri merged it for `sessionId`. An open
 * pull request stays cached for its TTL, so without this the PrimarySidebar row kept the open glyph for up to a minute
 * after the Status panel already showed the merge (issue #1549). Matching on the number alone may also refresh a
 * same-numbered pull request in another repository, which costs one extra lookup and cannot show a wrong state.
 */
export function refreshAfterMerge(
    service: Pick<SessionPullRequestService, 'refreshSession' | 'snapshot'>,
    sessionId: string,
    number: number,
): Promise<void> {
    const showing = Object.entries(service.snapshot().pullRequests)
        .filter(([, pullRequest]) => pullRequest.number === number)
        .map(([id]) => id);
    return service.refreshSession(sessionId, ...showing);
}
