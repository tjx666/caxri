import { useWorkbenchStore } from '../../../stores/workbench';
import { topLevelProjects } from '../../primary-sidebar/project-visibility';
import { agentAttentionCount } from '../agent-activity-rows';

const NO_RECORDS: never[] = [];

/**
 * How many Sessions need the user, counted by the rule that fills Activity's "Needs attention" group: the side bar's
 * Activity badge and the Zen Mode attention dot both read this, so the two never disagree.
 *
 * The count is computed inside the store selector and compared as a number, so a bootstrap update that changes any
 * other Session or Project field re-renders neither consumer.
 */
export function useAgentAttentionCount(): number {
    return useWorkbenchStore((state) =>
        agentAttentionCount(
            topLevelProjects(state.bootstrap?.projects ?? NO_RECORDS),
            state.bootstrap?.sessions ?? NO_RECORDS,
            state.bootstrap?.terminals ?? NO_RECORDS,
        ),
    );
}
