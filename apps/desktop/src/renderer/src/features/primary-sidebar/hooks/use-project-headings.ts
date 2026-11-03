import { useEffect, useMemo } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { environmentOfProject } from '../../../lib/environment-routing';
import {
    refreshProjectRepositories,
    useProjectRepositoriesStore,
} from '../../../stores/project-repositories';
import { useSelectedProject } from '../../../stores/selectors';
import type { MergedProject } from '../project-merge';
import {
    mergedGroupIdBySessionId,
    mergedProjectIdByMember,
    mergeProjectsByRepository as mergeProjectsByRepo,
} from '../project-merge';

/**
 * The side bar's Project headings: one per Project, except a repository checked out on several machines, which shows
 * once with every machine's Sessions under it. Every other side bar structure stays keyed by real Projects; only the
 * Session windows, the collapse record, and the order work per heading.
 */
export function useProjectHeadings({
    placement: { groupIdBySessionId },
    projects,
    sessions,
}: {
    /**
     * The delegated-Session placement, whose groups are still real Projects.
     */
    placement: { readonly groupIdBySessionId: ReadonlyMap<string, string> };
    projects: readonly ProjectRecord[];
    sessions: readonly SessionRecord[];
}): {
    /**
     * Each Session's group with merged Projects folded into their heading, for the collapse record.
     */
    headingIdBySessionId: ReadonlyMap<string, string>;
    /**
     * The heading id of every member Project; a Project missing from it is its own heading.
     */
    headingOf: ReadonlyMap<string, string>;
    /**
     * One record per heading, its lead Project's, for order and collapse.
     */
    headingProjects: ProjectRecord[];
    mergedProjects: readonly MergedProject[];
    /**
     * The heading that holds the selected Project's Sessions.
     */
    selectedProjectId: string | undefined;
} {
    const repoKeys = useProjectRepositoriesStore((store) => store.keys);
    useEffect(() => refreshProjectRepositories(projects), [projects]);
    const mergedProjects = useMemo(
        () =>
            mergeProjectsByRepo(projects, (projectId) => repoKeys[projectId], environmentOfProject),
        [projects, repoKeys],
    );
    const headingOf = useMemo(() => mergedProjectIdByMember(mergedProjects), [mergedProjects]);
    const headingProjects = useMemo(
        () =>
            mergedProjects.map(({ lead, members }) =>
                members.length === 1
                    ? lead
                    : // A merged heading stays fresh while any machine's checkout was visited recently.
                      {
                          ...lead,
                          lastVisitedAt: Math.max(...members.map((member) => member.lastVisitedAt)),
                      },
            ),
        [mergedProjects],
    );
    const selectedId = useSelectedProject()?.id;
    const headingIdBySessionId = useMemo(
        () => mergedGroupIdBySessionId(groupIdBySessionId, sessions, headingOf),
        [groupIdBySessionId, headingOf, sessions],
    );
    return {
        headingIdBySessionId,
        headingOf,
        headingProjects,
        mergedProjects,
        selectedProjectId:
            selectedId === undefined ? undefined : (headingOf.get(selectedId) ?? selectedId),
    };
}
