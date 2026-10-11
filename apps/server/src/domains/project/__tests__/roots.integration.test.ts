import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { resolveOwnerProjectRoot } from '../root-identity';
import { ProjectRootResolver } from '../roots';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ProjectRootResolver', () => {
    it('reports a missing stale directory after fallback without an internal filesystem error', async () => {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-root-fallback-'));
        const directory = await realpath(createdDirectory);
        temporaryDirectories.push(directory);
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        try {
            const owner = database.createProject(ownerRoot);
            const worktree = database.createProject(worktreeRoot);
            const session = database.createSession(owner.id, 'shell').session;
            const identity = await lstat(worktreeRoot, { bigint: true });
            database.selectWorkbenchProject(session.id, worktree.id, {
                device: identity.dev.toString(),
                inode: identity.ino.toString(),
            });
            const resolver = new ProjectRootResolver(database);
            await expect(
                resolver.resolveSessionPath(session.id, worktreeRoot),
            ).resolves.toMatchObject({ path: worktreeRoot });
            database.selectWorkbenchProject(session.id, owner.id);
            await rm(worktreeRoot, { recursive: true });

            await expect(
                resolver.resolveSessionPath(session.id, worktreeRoot),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                resolver.resolveSessionPath(session.id, 'missing.txt'),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(resolver.resolveSessionPath(session.id)).resolves.toMatchObject({
                path: ownerRoot,
            });
            await mkdir(worktreeRoot);
            await expect(
                resolver.resolveSessionPath(session.id, worktreeRoot),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        } finally {
            database.close();
        }
    });

    it('classifies a missing owner-authorized root as a denied path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-owner-root-missing-'));
        temporaryDirectories.push(directory);
        await expect(resolveOwnerProjectRoot(join(directory, 'missing'))).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });
    /**
     * A restart re-allocates the device number while the Renderer's first file reads race ahead of the focus-driven
     * validation sweep, so path resolution has to survive the drift on its own rather than wait to be re-anchored.
     *
     * @see https://github.com/tjx666/caxri/issues/1003
     */
    it('resolves an alternate Workbench Root whose device drifted but whose inode still matches', async () => {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-root-drift-'));
        temporaryDirectories.push(createdDirectory);
        const directory = await realpath(createdDirectory);
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        await writeFile(join(worktreeRoot, 'README.md'), '# Worktree\n');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        try {
            const owner = database.createProject(ownerRoot);
            const worktree = database.createProject(worktreeRoot);
            const session = database.createSession(owner.id, 'shell').session;
            const identity = await lstat(worktreeRoot, { bigint: true });
            database.selectWorkbenchProject(session.id, worktree.id, {
                device: 'device-from-a-previous-boot',
                inode: identity.ino.toString(),
            });

            await expect(
                new ProjectRootResolver(database).resolveSessionPath(session.id, 'README.md'),
            ).resolves.toMatchObject({
                root: worktreeRoot,
                path: join(worktreeRoot, 'README.md'),
            });
        } finally {
            database.close();
        }
    });

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

    it('classifies alternate Workbench Root removal during canonicalization as cancellation', async () => {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-root-race-'));
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
        const resolver = new ProjectRootResolver(database, {
            beforeRootRealpath: async () => {
                await rm(worktreeRoot, { recursive: true });
            },
        });

        try {
            await expect(resolver.resolveSessionPath(session.id)).rejects.toMatchObject({
                code: 'CANCELLED',
            });
        } finally {
            database.close();
        }
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
