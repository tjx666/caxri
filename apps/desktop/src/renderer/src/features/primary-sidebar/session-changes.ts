import type { GitOverview } from '@caxri/protocol';

import { translate } from '../../i18n';

/**
 * How long an open Session card trusts its last change count before reopening it reads again. There is no poll behind
 * it: the card reads only while open, so this bounds how often re-hovering the same rows re-asks the Server.
 */
export const SESSION_CHANGES_STALE_TIME_MS = 30_000;

/**
 * Where a Session card's Workbench Root sits relative to the selected Session.
 *
 * - `selected`: the card describes the selected Session itself.
 * - `watched`: another Session sharing the selected Session's Workbench Root, which the Server's Project file watcher
 *   keeps current, so its snapshot moves with every edit.
 * - `unwatched`: another Session in another root. Only the selected Session's root is file-watched, so a plain edit there
 *   never advances the Server's snapshot on its own.
 */
export type SessionChangesScope = 'selected' | 'unwatched' | 'watched';

interface SessionScopeRecord {
    id: string;
    workbenchProjectId: string;
}

export function sessionChangesScope(
    session: SessionScopeRecord,
    selectedSession: SessionScopeRecord | undefined,
): SessionChangesScope {
    if (session.id === selectedSession?.id) return 'selected';
    return session.workbenchProjectId === selectedSession?.workbenchProjectId
        ? 'watched'
        : 'unwatched';
}

/**
 * Whether a Session card should show a `Changes` row at all.
 *
 * The selected Session is excluded because the Workbench already shows its count exactly: the Git tab badge subtracts
 * the gitlink rows a submodule section hides, which the `files[]`-free overview cannot, so a second, occasionally
 * different number for the same scope would sit on the same screen.
 */
export function shouldShowSessionChanges(scope: SessionChangesScope | undefined): boolean {
    return scope !== undefined && scope !== 'selected';
}

/**
 * The `git.overview` parameters a card reads with. An `unwatched` root asks for a refreshed snapshot, since nothing
 * else would ever advance it; a `watched` one joins the snapshot the file watcher keeps current, because forcing it
 * would also announce `git.changed` to the selected Session's own Git views for nothing.
 */
export function sessionChangesQueryParameters(
    sessionId: string,
    scope: SessionChangesScope | undefined,
): { sessionId: string; refresh?: true } {
    return scope === 'unwatched' ? { sessionId, refresh: true } : { sessionId };
}

/**
 * Uncommitted changes across every repository of a Session's Workbench Root, from the `files[]`-free overview.
 * `changedFileCount` is each repository's untruncated total, so a large change set still counts in full. `undefined`
 * means there is no honest number to show: not a repository, or a read that failed.
 */
export function sessionChangeCount(overview: GitOverview | undefined): number | undefined {
    if (!overview?.isRepository || overview.error !== undefined) return undefined;
    return overview.repositories.reduce((total, repo) => total + repo.changedFileCount, 0);
}

export interface SessionChangesPresentation {
    ariaLabel: string;
    value: string;
}

/**
 * The card's `Changes` row. The copy names the working tree rather than the Session's Agent, because several Sessions
 * can share one Workbench Root and any of them, or the user, may have made the edits. Zero hides the row the same way
 * zero hides the Git tab badge: a clean tree is the resting state, not news.
 */
export function sessionChangesPresentation(
    count: number | undefined,
): SessionChangesPresentation | undefined {
    if (count === undefined || count === 0) return undefined;
    return {
        ariaLabel: translate(
            count === 1
                ? 'primarySidebar.changes.ariaLabelOne'
                : 'primarySidebar.changes.ariaLabelOther',
            { count },
        ),
        value: String(count),
    };
}
