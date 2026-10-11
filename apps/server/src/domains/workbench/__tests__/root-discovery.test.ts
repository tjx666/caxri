import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixture } from './roots.fixture';

describe('Workbench Root discovery', () => {
    it('binds discovered IDs to the Session and rejects replaced directories before registration', async () => {
        const context = await fixture(2);
        try {
            const sessionId = context.sessions[0].session.id;
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature', rootPath: context.worktreeRoot },
            ]);
            const roots = await context.service.listOptions(sessionId);
            const root = roots.find((option) => option.authorization === 'required')!;
            await expect(
                context.service.resolveWorktree(context.sessions[1].session.id, root.worktreeId),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(context.service.resolveWorktree(sessionId, root.worktreeId)).resolves.toBe(
                context.worktreeRoot,
            );
            await rename(context.worktreeRoot, join(context.directory, 'previous-worktree'));
            await mkdir(context.worktreeRoot);
            await expect(
                context.service.resolveWorktree(sessionId, root.worktreeId),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                context.service.authorizeSelection(sessionId, root.rootPath, root.worktreeId),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
        } finally {
            await context.service.close();
            context.database.close();
        }
    });

    it('rejects removed topology entries and arbitrary IDs without granting access', async () => {
        const context = await fixture();
        try {
            const sessionId = context.sessions[0].session.id;
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature', rootPath: context.worktreeRoot },
            ]);
            const root = (await context.service.listOptions(sessionId)).find(
                (option) => option.authorization === 'required',
            )!;
            context.setWorktrees([{ branch: 'main', rootPath: context.ownerRoot }]);
            await expect(
                context.service.resolveWorktree(sessionId, root.worktreeId),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                context.service.resolveWorktree(sessionId, '/arbitrary/path'),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                context.service.authorizeSelection(sessionId, root.rootPath, root.worktreeId),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
            expect(context.database.listProjects()).toHaveLength(1);
        } finally {
            await context.service.close();
            context.database.close();
        }
    });

    it('marks the actual main checkout and preserves independently added Project ownership', async () => {
        const context = await fixture();
        try {
            const sessionId = context.sessions[0].session.id;
            const independent = context.database.createProject(context.worktreeRoot);
            context.setWorktrees([
                { branch: 'main', rootPath: context.worktreeRoot },
                { branch: 'feature/owner', rootPath: context.ownerRoot },
            ]);
            await writeFile(join(context.ownerRoot, '.git'), 'gitdir: fixture');
            const roots = await context.service.listOptions(sessionId);
            expect(roots.find((root) => root.isMain)).toMatchObject({
                projectId: independent.id,
                authorization: 'authorized',
                owner: false,
            });
            expect(roots.find((root) => root.owner)).toMatchObject({ isMain: false });
            const root = roots.find((option) => option.projectId === independent.id)!;
            await context.service.authorizeSelection(sessionId, root.rootPath, root.worktreeId);
            expect(context.database.getProject(independent.id)?.ownerProjectId).toBeUndefined();
        } finally {
            await context.service.close();
            context.database.close();
        }
    });

    it('lists unapproved linked worktrees without granting access or following an Agent', async () => {
        const context = await fixture();
        try {
            const sessionId = context.sessions[0].session.id;
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/discovered', rootPath: context.worktreeRoot },
            ]);

            const roots = await context.service.listOptions(sessionId);

            expect(roots.find((root) => root.authorization === 'required')).toMatchObject({
                branch: 'feature/discovered',
                rootPath: context.worktreeRoot,
                authorization: 'required',
            });
            expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
            expect(context.database.getSession(sessionId)?.workbenchProjectId).toBe(
                context.owner.id,
            );
            expect(context.events.filter((event) => event.event === 'workbench.candidate')).toEqual(
                [],
            );
        } finally {
            await context.service.close();
            context.database.close();
        }
    });
});
