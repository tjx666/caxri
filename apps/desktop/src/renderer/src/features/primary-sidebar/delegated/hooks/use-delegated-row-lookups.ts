import { useMemo } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { worktreeProjectsBySession } from '../../project-visibility';
import type { DelegatedPlacement } from '../delegated-placement';
import { nestedSessions } from '../delegated-placement';

/**
 * What a nested Session row needs to know about records other than its own.
 */
export interface DelegatedRowLookups {
    /**
     * The full Project catalog by id, hidden worktree Projects included: a nested Session shows its own Project's name,
     * and that Project is usually not the one whose heading its host sits under.
     */
    projectsById: ReadonlyMap<string, ProjectRecord>;
    /**
     * Every Session by id, so a nested row can name the Session that created it.
     */
    sessionsById: ReadonlyMap<string, SessionRecord>;
    /**
     * Workbench Root Projects keyed by nested Session id, for the ones working in a linked worktree. A delegated task
     * often runs in one, and the row's accessible description is where that becomes readable.
     */
    worktreeProjects: Record<string, ProjectRecord>;
}

/**
 * The record lookups behind the nested Session rows, built once per change to the Projects, the Sessions, or where the
 * Sessions are placed, so a row receives plain fields instead of searching the catalog itself.
 */
export function useDelegatedRowLookups({
    allProjects,
    placement,
    sessions,
}: {
    allProjects: readonly ProjectRecord[];
    placement: Pick<DelegatedPlacement, 'nestedByHost'>;
    sessions: readonly SessionRecord[];
}): DelegatedRowLookups {
    const projectsById = useMemo(
        () => new Map(allProjects.map((project) => [project.id, project])),
        [allProjects],
    );
    const sessionsById = useMemo(
        () => new Map(sessions.map((session) => [session.id, session])),
        [sessions],
    );
    const worktreeProjects = useMemo(
        () => worktreeProjectsBySession(nestedSessions(placement), allProjects),
        [allProjects, placement],
    );
    return useMemo(
        () => ({ projectsById, sessionsById, worktreeProjects }),
        [projectsById, sessionsById, worktreeProjects],
    );
}
