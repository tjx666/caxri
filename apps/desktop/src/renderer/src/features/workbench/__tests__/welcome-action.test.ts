import type { ProjectRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { selectWelcomeAction } from '../welcome-action';

function project(id: string, lastVisitedAt: number, extra: Partial<ProjectRecord> = {}) {
    return {
        id,
        rootPath: `/projects/${id}`,
        title: id,
        orderIndex: 0,
        createdAt: 0,
        lastVisitedAt,
        ...extra,
    };
}

describe('selectWelcomeAction', () => {
    it('offers Add Project when there are no Projects', () => {
        expect(selectWelcomeAction([])).toEqual({ kind: 'addProject' });
    });

    it('offers a new Session in the most recently opened Project', () => {
        expect(selectWelcomeAction([project('a', 10), project('b', 30), project('c', 20)])).toEqual(
            {
                kind: 'newSession',
                projectId: 'b',
                projectTitle: 'b',
            },
        );
    });

    it('skips worktree Projects the sidebar does not list', () => {
        expect(
            selectWelcomeAction([project('a', 10), project('w', 99, { ownerProjectId: 'a' })]),
        ).toMatchObject({ projectId: 'a' });
        expect(selectWelcomeAction([project('w', 99, { ownerProjectId: 'a' })])).toEqual({
            kind: 'addProject',
        });
    });
});
