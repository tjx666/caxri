import { useEffect, useId } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';
import { selectSelectedSession } from '../../../stores/selectors';
import { useWorkbenchStore } from '../../../stores/workbench';
import type { SessionChangesPresentation } from '../session-changes';
import {
    SESSION_CHANGES_STALE_TIME_MS,
    sessionChangeCount,
    sessionChangesPresentation,
    sessionChangesQueryParameters,
    sessionChangesScope,
    shouldShowSessionChanges,
} from '../session-changes';
import {
    claimSessionChangesReader,
    releaseSessionChangesReader,
    useSessionChangesReaderStore,
} from '../session-changes-reader-store';

/**
 * The `Changes` row of one Session card, read from `git.overview`, the `files[]`-free projection of the Server's shared
 * repository snapshot.
 *
 * Nothing is read while the card is closed: the scope selector short-circuits, so a resting row neither scans the
 * Session list nor holds an enabled query. An open card claims the one reader slot, and only the claimant's query is
 * enabled; `select` narrows the subscription to the count so a refresh that moved nothing re-renders nothing.
 */
export function useSessionChanges(
    session: Pick<SessionRecord, 'id' | 'workbenchProjectId'>,
    isOpen: boolean,
): SessionChangesPresentation | undefined {
    const readerId = useId();
    const scope = useWorkbenchStore((state) =>
        isOpen ? sessionChangesScope(session, selectSelectedSession(state.bootstrap)) : undefined,
    );
    const shouldShowChanges = shouldShowSessionChanges(scope);
    useEffect(() => {
        if (!shouldShowChanges) return;
        claimSessionChangesReader(readerId);
        return () => releaseSessionChangesReader(readerId);
    }, [readerId, shouldShowChanges]);
    const isReader = useSessionChangesReaderStore((state) => state.readerId === readerId);
    const { data: count } = useCaxriQuery(
        'git.overview',
        sessionChangesQueryParameters(session.id, scope),
        {
            enabled: shouldShowChanges && isReader,
            select: sessionChangeCount,
            staleTime: SESSION_CHANGES_STALE_TIME_MS,
        },
    );
    return shouldShowChanges ? sessionChangesPresentation(count) : undefined;
}
