import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeTopology } from '../../git/index';
import { fixture } from './roots.fixture';

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
            workbenchRootProjectId: secondProject.id,
            rootPath: secondWorktreeRoot,
        });
        expect(
            context.events.filter(
                (event) =>
                    event.event === 'workbench.changed' && event.payload.reason === 'fallback',
            ),
        ).toHaveLength(fallbackCount);
        expect(firstSelection.workbenchRootProjectId).not.toBe(secondProject.id);
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

    /**
     * Every volume's `st_dev` is re-allocated by macOS on boot, so a persisted device number stops matching after a
     * restart even though nothing on disk moved.
     *
     * @see https://github.com/tjx666/caxri/issues/1003
     */
    it('keeps a binding whose device drifted but whose inode and topology still agree', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
        ]);
        const sessionId = context.sessions[0].session.id;
        const selected = await context.service.authorizeSelection(sessionId, context.worktreeRoot);
        const bound = context.database.getSessionWorkbenchBinding(sessionId)!;
        context.database.selectWorkbenchProject(sessionId, selected.workbenchRootProjectId, {
            device: 'device-from-a-previous-boot',
            inode: bound.rootInode!,
        });
        const changesBefore = context.events.filter(
            (event) => event.event === 'workbench.changed',
        ).length;

        await expect(context.service.validateSession(sessionId)).resolves.toBe(false);

        expect(context.database.getSessionWorkbenchBinding(sessionId)).toMatchObject({
            workbenchRootProjectId: selected.workbenchRootProjectId,
            rootDevice: bound.rootDevice,
            rootInode: bound.rootInode,
        });
        await expect(context.projectRoots.resolveSessionPath(sessionId)).resolves.toMatchObject({
            root: context.worktreeRoot,
        });
        // The root never moved, so re-anchoring must stay invisible instead of redrawing the Session.
        expect(context.events.filter((event) => event.event === 'workbench.changed')).toHaveLength(
            changesBefore,
        );
        const logged = await context.readLogEvents();
        expect(
            logged
                .filter((entry) => entry.event === 'workbench_root.rebound')
                .map((entry) => entry.fields),
        ).toEqual([
            {
                reason: 'device_drift',
                sessionId,
                workbenchRootProjectId: selected.workbenchRootProjectId,
            },
        ]);
        await context.service.close();
        context.database.close();
    });

    it('falls back when the inode changed, even while the device still matches', async () => {
        const context = await fixture();
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/first', rootPath: context.worktreeRoot },
        ]);
        const sessionId = context.sessions[0].session.id;
        const selected = await context.service.authorizeSelection(sessionId, context.worktreeRoot);
        const bound = context.database.getSessionWorkbenchBinding(sessionId)!;
        context.database.selectWorkbenchProject(sessionId, selected.workbenchRootProjectId, {
            device: bound.rootDevice!,
            inode: 'inode-of-a-replaced-directory',
        });

        await expect(context.service.validateSession(sessionId)).resolves.toBe(true);

        expect(context.database.getSessionWorkbenchBinding(sessionId)).toMatchObject({
            projectId: context.owner.id,
            workbenchRootProjectId: context.owner.id,
        });
        await context.service.close();
        context.database.close();
    });
});
