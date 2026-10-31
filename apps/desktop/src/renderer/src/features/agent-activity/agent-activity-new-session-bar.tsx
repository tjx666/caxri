import { useMemo } from 'react';

import { useProjects, useSelectedProject } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
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
    const projects = useMemo(() => topLevelProjects(allProjects ?? NO_RECORDS), [allProjects]);
    /**
     * The Project `session.create` targets (the selected Session's), so the row and the shortcut agree. A selection in
     * a hidden worktree Project falls back to the first listed Project, since the menu cannot name a hidden one.
     */
    const defaultProject =
        projects.find((project) => project.id === selectedProject?.id) ?? projects.at(0);
    if (defaultProject === undefined) return null;
    return (
        <div className="agent-activity-new-session-bar flex-none px-2 pt-2">
            <ActivitySessionCreationMenu defaultProject={defaultProject} projects={projects} />
        </div>
    );
}
