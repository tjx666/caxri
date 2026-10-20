import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { readActiveContext } from '../active-context';

function database(visibleProjectIds: string[]) {
    const session = {
        id: 'session-1',
        projectId: 'project-owner',
        workbenchProjectId: 'project-worktree',
    } as SessionRecord;
    return {
        getSession: (id: string) => (id === session.id ? session : undefined),
        listVisibleProjects: () => visibleProjectIds.map((id) => ({ id }) as ProjectRecord),
    } as unknown as Parameters<typeof readActiveContext>[0];
}

describe('readActiveContext', () => {
    it('projects the owner and selected Workbench Root as distinct identities', () => {
        expect(readActiveContext(database(['project-owner']), () => 'session-1')).toEqual({
            ownerProjectId: 'project-owner',
            projectIds: ['project-owner'],
            sessionId: 'session-1',
            workbenchProjectId: 'project-worktree',
        });
    });

    it('reports no selection when none is stored, it no longer exists, or its Project is hidden', () => {
        for (const [selected, visible] of [
            [undefined, ['project-owner']],
            ['session-gone', ['project-owner']],
            ['session-1', ['project-other']],
        ] as const)
            expect(readActiveContext(database([...visible]), () => selected)).toEqual({
                projectIds: [...visible],
            });
    });
});
