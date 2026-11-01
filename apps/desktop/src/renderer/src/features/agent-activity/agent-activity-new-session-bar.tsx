import { useMemo } from 'react';

import { useProjects, useSelectedProject } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import {
    resolveActivitySessionProject,
    useActivitySessionProjectStore,
} from '../session/activity-session-project-store';
import { ActivitySessionCreationMenu } from '../session/create-session-menu';

const NO_RECORDS: never[] = [];

/**
 * The Activity view's New Session entry. Rendered outside the tree: it is not a row of the queue, and inside
 * `role="tree"` a focusable element has to be one. It stays above the scroller so the entry never scrolls away behind a
 * long queue.
 */
export function AgentActivityNewSessionBar() {
    const allProjects = useProjects();
    const selectedProject = useSelectedProject();
    const rememberedProjectId = useActivitySessionProjectStore((state) => state.projectId);
    const projects = useMemo(() => topLevelProjects(allProjects ?? NO_RECORDS), [allProjects]);
    /**
     * The Project the user last picked in this row's list, else the selected Session's (the one `session.create`
     * targets); see `resolveActivitySessionProject`.
     */
    const defaultProject = resolveActivitySessionProject(
        projects,
        rememberedProjectId,
        selectedProject?.id,
    );
    if (defaultProject === undefined) return null;
    return (
        <div className="agent-activity-new-session-bar flex-none px-2 pt-2">
            <ActivitySessionCreationMenu defaultProject={defaultProject} projects={projects} />
        </div>
    );
}
