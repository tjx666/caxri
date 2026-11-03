import { useMemo } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import type { DelegatedPlacement } from '../delegated-placement';
import { placeDelegatedSessions } from '../delegated-placement';

/**
 * Where the Project tree puts every Session (an ordinary row, nested under a host, or hidden), recomputed only when the
 * Session records, the listed Projects, or the selected Session change. Everything that builds the tree reads this one
 * result, so the groups, the Pinned group, the keyboard row order, the collapse protection, and the rollups always
 * agree on which rows exist.
 */
export function useDelegatedPlacement({
    projects,
    selectedSessionId,
    sessions,
}: {
    /**
     * The Projects the tree lists, not the full catalog.
     */
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>;
    selectedSessionId: string | undefined;
    /**
     * Every Session record, archived ones included.
     */
    sessions: readonly SessionRecord[];
}): DelegatedPlacement {
    return useMemo(
        () => placeDelegatedSessions({ projects, selectedSessionId, sessions }),
        [projects, selectedSessionId, sessions],
    );
}
