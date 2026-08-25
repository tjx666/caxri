import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../db/repository';
import { ProjectRootResolver } from '../project-roots';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ProjectRootResolver', () => {
    it('rejects an alternate Workbench Root replaced after its inode was authorized', async () => {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-root-replaced-'));
        temporaryDirectories.push(createdDirectory);
        const directory = await realpath(createdDirectory);
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const session = database.createSession(owner.id, 'shell').session;
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        await rename(worktreeRoot, `${worktreeRoot}-original`);
        await mkdir(worktreeRoot);

        await expect(
            new ProjectRootResolver(database).resolveSessionPath(session.id),
        ).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
        database.close();
    });

    it('classifies a removed alternate Workbench Root as stale request cancellation', async () => {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-root-removed-'));
        temporaryDirectories.push(createdDirectory);
        const directory = await realpath(createdDirectory);
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const session = database.createSession(owner.id, 'shell').session;
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        await rm(worktreeRoot, { recursive: true });

        await expect(
            new ProjectRootResolver(database).resolveSessionPath(session.id),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
        database.close();
    });

    it('rejects a Project root replaced between metadata validation and realpath', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-root-race-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(root), mkdir(outside)]);
        await writeFile(join(outside, 'target.txt'), 'outside', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const resolver = new ProjectRootResolver(database, {
            beforeRootRealpath: async () => {
                await rename(root, `${root}-original`);
                await symlink(outside, root);
            },
        });

        try {
            await expect(
                resolver.resolveSessionPath(session.id, join(root, 'target.txt')),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        } finally {
            database.close();
        }
    });

    it('rejects a canonical root captured while a transient replacement is active', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-root-transient-race-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const originalRoot = `${root}-original`;
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(root), mkdir(outside)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const resolver = new ProjectRootResolver(database, {
            beforeRootRealpath: async () => {
                await rename(root, originalRoot);
                await symlink(outside, root);
            },
            afterRootRealpath: async () => {
                await rm(root);
                await rename(originalRoot, root);
            },
        });

        try {
            await expect(resolver.resolveSessionPath(session.id)).rejects.toMatchObject({
                code: 'PATH_DENIED',
            });
        } finally {
            database.close();
        }
    });
});
