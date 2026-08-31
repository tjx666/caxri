import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeTopology } from '../git';
import { fixture } from './workbench-roots.fixture';

describe('WorkbenchRootService validation', () => {
    it('coalesces concurrent topology reads for the same owning Project', async () => {
        const context = await fixture();
        const pending = Promise.withResolvers<GitWorktreeTopology>();
        context.worktreeTopology.mockImplementationOnce(() => pending.promise);

        const reads = Promise.all([
            context.service.listOptions(context.sessions[0].session.id),
            context.service.listOptions(context.sessions[0].session.id),
        ]);
        await vi.waitFor(() => expect(context.worktreeTopology).toHaveBeenCalledTimes(1));
        pending.resolve(context.getTopology());

        await expect(reads).resolves.toHaveLength(2);
        expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
        await context.service.close();
        context.database.close();
    });

    it('does not let stale validation overwrite a newer Workbench Root selection', async () => {
        const context = await fixture();
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
            { branch: 'feature/second', rootPath: secondWorktreeRoot },
        ]);
        const firstSelection = await context.service.authorizeSelection(
            context.sessions[0].session.id,
            context.worktreeRoot,
        );
        const secondProject = context.database.createProject(secondWorktreeRoot);
        const internals = context.service as unknown as {
            rootIdentity(rootPath: string): Promise<{ device: string; inode: string }>;
        };
        const originalRootIdentity = internals.rootIdentity.bind(context.service);
        const pendingIdentity = Promise.withResolvers<{ device: string; inode: string }>();
        const identity = vi
            .spyOn(internals, 'rootIdentity')
            .mockImplementation((rootPath) =>
                rootPath === context.worktreeRoot
                    ? pendingIdentity.promise
                    : originalRootIdentity(rootPath),
            );
        const fallbackCount = context.events.filter(
            (event) => event.event === 'workbench.changed' && event.payload.reason === 'fallback',
        ).length;

        const validation = context.service.validateSession(context.sessions[0].session.id);
        await vi.waitFor(() => expect(identity).toHaveBeenCalledWith(context.worktreeRoot));
        await context.service.select(context.sessions[0].session.id, secondProject.id);
        pendingIdentity.resolve({ device: 'stale-device', inode: 'stale-inode' });

        await expect(validation).resolves.toBe(false);
        expect(context.database.getSession(context.sessions[0].session.id)).toMatchObject({
            projectId: context.owner.id,
            workbenchProjectId: secondProject.id,
            rootPath: secondWorktreeRoot,
        });
        expect(
            context.events.filter(
                (event) =>
                    event.event === 'workbench.changed' && event.payload.reason === 'fallback',
            ),
        ).toHaveLength(fallbackCount);
        expect(firstSelection.workbenchProjectId).not.toBe(secondProject.id);
        await context.service.close();
        context.database.close();
    });

    it('shares one topology read while validating Sessions with the same owner', async () => {
        const context = await fixture(2);
        const secondWorktreeRoot = join(context.directory, 'second-worktree');
        await mkdir(secondWorktreeRoot);
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
            { branch: 'feature/second', rootPath: secondWorktreeRoot },
        ]);
        const firstProject = context.database.createProject(context.worktreeRoot);
        const secondProject = context.database.createProject(secondWorktreeRoot);
        await context.service.select(context.sessions[0].session.id, firstProject.id);
        await context.service.select(context.sessions[1].session.id, secondProject.id);
        context.worktreeTopology.mockClear();

        await context.service.validate();

        expect(context.worktreeTopology).toHaveBeenCalledTimes(1);
        await context.service.close();
        context.database.close();
    });

    it('rejects a root replaced between its identity read and canonicalization', async () => {
        let swapRoot: (() => Promise<void>) | undefined;
        const context = await fixture(1, {
            beforeRootIdentityRealpath: async () => swapRoot?.(),
        });
        const displacedRoot = join(context.directory, 'displaced-worktree');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/replaced', rootPath: context.worktreeRoot },
        ]);
        swapRoot = async () => {
            swapRoot = undefined;
            await rename(context.worktreeRoot, displacedRoot);
            await mkdir(context.worktreeRoot);
        };

        await expect(
            context.service.authorizeSelection(
                context.sessions[0].session.id,
                context.worktreeRoot,
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(context.database.findProjectByRootPath(context.worktreeRoot)).toBeUndefined();
        await context.service.close();
        context.database.close();
    });
});
