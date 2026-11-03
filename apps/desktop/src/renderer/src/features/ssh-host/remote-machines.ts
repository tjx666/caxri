import type { ProjectRecord } from '@caxri/protocol';

import { environmentOfProject } from '../../lib/environment-routing';

/**
 * The SSH Hosts among `members`' machines, in member order; this Mac's checkout has none.
 */
export function remoteMachinesOf(members: readonly ProjectRecord[]): string[] {
    return members.flatMap((member) => {
        const environmentId = environmentOfProject(member.id);
        return environmentId === undefined ? [] : [environmentId];
    });
}
