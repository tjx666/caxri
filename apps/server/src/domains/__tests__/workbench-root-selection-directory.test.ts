import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixture } from './workbench-roots.fixture';

describe('Workbench Root selection directory', () => {
    it('uses an unauthorized linked root without granting access', async () => {
        const context = await fixture();
        const sessionId = context.sessions[0].session.id;
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature', rootPath: join(context.directory, 'worktrees', 'feature') },
        ]);

        expect(await context.service.selectionDirectory(sessionId)).toBe(
            join(context.directory, 'worktrees'),
        );
        expect(context.database.listProjects()).toHaveLength(1);
        expect(context.database.getSession(sessionId)?.workbenchProjectId).toBe(context.owner.id);
        await context.service.close();
        context.database.close();
    });

    it('prefers the selected linked root over another worktree directory', async () => {
        const context = await fixture();
        const sessionId = context.sessions[0].session.id;
        const active = context.database.createProject(context.worktreeRoot);
        context.database.selectWorkbenchProject(sessionId, active.id);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'other', rootPath: join(context.directory, 'other-worktrees', 'other') },
            { branch: 'active', rootPath: context.worktreeRoot },
        ]);

        expect(await context.service.selectionDirectory(sessionId)).toBe(context.directory);
        await context.service.close();
        context.database.close();
    });

    it('falls back to the repository parent when no linked roots exist or Git fails', async () => {
        const context = await fixture();
        const sessionId = context.sessions[0].session.id;

        expect(await context.service.selectionDirectory(sessionId)).toBe(context.directory);
        context.worktreeTopology.mockRejectedValueOnce(new Error('Git unavailable'));
        expect(await context.service.selectionDirectory(sessionId)).toBe(context.directory);
        await context.service.close();
        context.database.close();
    });

    it('keeps an independently added linked Project beside its own worktree', async () => {
        const context = await fixture();
        const sessionId = context.sessions[0].session.id;
        context.setWorktrees([
            { branch: 'main', rootPath: join(context.directory, 'main-repository', 'root') },
            { branch: 'feature', rootPath: context.ownerRoot },
        ]);

        expect(await context.service.selectionDirectory(sessionId)).toBe(context.directory);
        await context.service.close();
        context.database.close();
    });

    it('rejects unknown Sessions before consulting Git', async () => {
        const context = await fixture();

        await expect(context.service.selectionDirectory('missing')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(context.worktreeTopology).not.toHaveBeenCalled();
        await context.service.close();
        context.database.close();
    });
});
