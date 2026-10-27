import type { ProjectRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionWorktreeProject, topLevelProjects } from '../project-visibility';

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    return {
        id: 'project-owner',
        rootPath: '/repo',
        title: 'repo',
        orderIndex: 0,
        createdAt: 0,
        lastVisitedAt: 0,
        ...overrides,
    };
}

/**
 * Shared by the PrimarySidebar tree and the Command Palette's Projects group; both must agree that an auto-registered
 * worktree Project is not something the user can pick.
 */
describe('topLevelProjects', () => {
    it('hides worktree Projects registered on another Project behalf', () => {
        const owner = project();
        const worktree = project({
            id: 'project-worktree',
            rootPath: '/repo-feature',
            title: 'repo-feature',
            ownerProjectId: 'project-owner',
        });

        expect(topLevelProjects([owner, worktree])).toEqual([owner]);
    });

    it('keeps a worktree directory the user added as its own Project', () => {
        const adopted = project({
            id: 'project-adopted',
            rootPath: '/repo-feature',
            title: 'repo-feature',
        });

        expect(topLevelProjects([project(), adopted])).toHaveLength(2);
    });

    it('preserves the incoming Project order', () => {
        const first = project({ id: 'project-first' });
        const hidden = project({ id: 'project-hidden', ownerProjectId: 'project-first' });
        const last = project({ id: 'project-last' });

        expect(topLevelProjects([first, hidden, last]).map(({ id }) => id)).toEqual([
            'project-first',
            'project-last',
        ]);
    });
});

describe('sessionWorktreeProject', () => {
    const worktree = project({ id: 'project-worktree', title: 'repo-feature' });

    it('resolves the bound Project when a Session works outside its own root', () => {
        expect(
            sessionWorktreeProject(
                { projectId: 'project-owner', workbenchRootProjectId: 'project-worktree' },
                [project(), worktree],
            ),
        ).toBe(worktree);
    });

    it('marks nothing when the Session works in its own Project', () => {
        expect(
            sessionWorktreeProject(
                { projectId: 'project-owner', workbenchRootProjectId: 'project-owner' },
                [project(), worktree],
            ),
        ).toBeUndefined();
    });

    it('marks nothing when the bound Project is no longer present', () => {
        expect(
            sessionWorktreeProject(
                { projectId: 'project-owner', workbenchRootProjectId: 'project-removed' },
                [project()],
            ),
        ).toBeUndefined();
    });
});
