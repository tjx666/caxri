import { useMemo } from 'react';

import { useProjects, useSessions } from '../../../stores/selectors';
import { topLevelProjects } from '../../primary-sidebar/project-visibility';
import { agentAttentionCount } from '../agent-activity-rows';

const NO_RECORDS: never[] = [];

/**
 * How many Sessions need the user, counted the way Activity's "Needs attention" group is: the side bar's Activity badge
 * and the Zen Mode attention dot both read this, so the two never disagree.
 */
export function useAgentAttentionCount(): number {
    const allProjects = useProjects();
    const sessions = useSessions() ?? NO_RECORDS;
    return useMemo(
        () => agentAttentionCount(topLevelProjects(allProjects ?? NO_RECORDS), sessions),
        [allProjects, sessions],
    );
}
