import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
    type DesktopLeaseHandle,
} from './desktop-lease';
import { getProcessIdentity, runCapture } from './process';
import {
    pathExists,
    repositoryContext,
    withRepositoryLock,
    worktreeDirectory,
    writeJsonAtomic,
} from './repository';
import { runCli } from './switch-worktree';
import {
    createWorktree,
    devWorktree,
    doctorWorktree,
    listWorktreeStatus,
    prepareDevWorktree,
    removeWorktree,
    switchWorktree,
} from './worktree';

interface Fixture {
    remote: string;
    root: string;
    temporary: string;
}

const temporaryDirectories: string[] = [];
const activeLeases: DesktopLeaseHandle[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
    return await runCapture('git', args, cwd);
}

async function createFixture(): Promise<Fixture> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-switch-worktree-'));
    temporaryDirectories.push(temporary);
    const remote = join(temporary, 'remote.git');
    const root = join(temporary, 'caxri');
    await mkdir(root);
    await git(temporary, 'init', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await git(root, 'add', 'README.md', '.gitignore');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-u', 'origin', 'main');
    await mkdir(join(root, 'node_modules'));
    return { remote, root, temporary };
}

async function fakeInstall(path: string): Promise<void> {
    await mkdir(join(path, 'node_modules'));
}

afterEach(async () => {
    await Promise.all(activeLeases.splice(0).map((lease) => releaseDesktopLease(lease)));
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('switch-worktree creation and diagnostics', () => {
    it('creates from origin/main without changing the invoking checkout', async () => {
        const fixture = await createFixture();
        const upstream = join(fixture.temporary, 'upstream');
        await git(fixture.temporary, 'clone', fixture.remote, upstream);
        await git(upstream, 'config', 'user.email', 'upstream@example.invalid');
        await git(upstream, 'config', 'user.name', 'Upstream Test');
        await writeFile(join(upstream, 'upstream.txt'), 'latest\n', 'utf8');
        await git(upstream, 'add', 'upstream.txt');
        await git(upstream, 'commit', '-m', 'upstream change');
        await git(upstream, 'push', 'origin', 'main');
        await writeFile(join(fixture.root, 'local-note.txt'), 'preserve me\n', 'utf8');
        const beforeBranch = (await git(fixture.root, 'branch', '--show-current')).trim();
        const beforeHead = (await git(fixture.root, 'rev-parse', 'HEAD')).trim();
        const beforeStatus = await git(fixture.root, 'status', '--porcelain');
        let installs = 0;

        const created = await createWorktree({
            branch: 'feat/example',
            cwd: fixture.root,
            install: async (path) => {
                installs += 1;
                await fakeInstall(path);
            },
        });

        const context = await repositoryContext(fixture.root);
        expect(created.path).toBe(worktreeDirectory(context, 'feat/example'));
        expect(created.path).toContain(
            `${join(dirname(fixture.root), 'caxri-worktrees')}/feat%2Fexample`,
        );
        expect(created.branch).toBe('feat/example');
        expect(created.dependencies).toBe('ready');
        expect(created.managed).toBe(true);
        expect(created.profile).toBeTruthy();
        expect(installs).toBe(1);
        expect(created.head).toBe((await git(upstream, 'rev-parse', 'HEAD')).trim());
        expect((await git(fixture.root, 'branch', '--show-current')).trim()).toBe(beforeBranch);
        expect((await git(fixture.root, 'rev-parse', 'HEAD')).trim()).toBe(beforeHead);
        expect(await git(fixture.root, 'status', '--porcelain')).toBe(beforeStatus);
        expect((await doctorWorktree(created.path)).valid).toBe(true);
    });

    it('returns an existing checkout and materializes an unused local branch once', async () => {
        const fixture = await createFixture();
        let installs = 0;
        const install = async (path: string): Promise<void> => {
            installs += 1;
            await fakeInstall(path);
        };
        const created = await createWorktree({
            branch: 'fix/issue-66-existing',
            cwd: fixture.root,
            install,
        });

        expect(
            (
                await createWorktree({
                    branch: 'fix/issue-66-existing',
                    cwd: created.path,
                    install,
                })
            ).path,
        ).toBe(created.path);
        expect((await switchWorktree(fixture.root, 'fix/issue-66-existing', install)).path).toBe(
            created.path,
        );
        expect((await switchWorktree(fixture.root, created.path, install)).path).toBe(created.path);
        expect(installs).toBe(1);

        await git(fixture.root, 'branch', 'feat/dormant', 'origin/main');
        const switched = await switchWorktree(fixture.root, 'feat/dormant', install);
        expect(switched.branch).toBe('feat/dormant');
        expect(switched.dependencies).toBe('ready');
        expect(installs).toBe(2);
    });

    it('repairs a managed checkout when its first dependency installation fails', async () => {
        const fixture = await createFixture();
        const failInstall = (): Promise<void> => Promise.reject(new Error('temporary ni failure'));

        await expect(
            createWorktree({
                branch: 'fix/retry-create-install',
                cwd: fixture.root,
                install: failInstall,
            }),
        ).rejects.toThrow('temporary ni failure');
        const created = await createWorktree({
            branch: 'fix/retry-create-install',
            cwd: fixture.root,
            install: fakeInstall,
        });
        expect(created.dependencies).toBe('ready');
        expect((await doctorWorktree(created.path)).valid).toBe(true);

        await expect(
            createWorktree({
                branch: 'fix/retry-switch-install',
                cwd: fixture.root,
                install: failInstall,
            }),
        ).rejects.toThrow('temporary ni failure');
        const switched = await switchWorktree(
            fixture.root,
            'fix/retry-switch-install',
            fakeInstall,
        );
        expect(switched.dependencies).toBe('ready');
        expect((await doctorWorktree(switched.path)).valid).toBe(true);
    });

    it('reports deterministic list fields and rejects non-semantic new branches', async () => {
        const fixture = await createFixture();
        await expect(
            createWorktree({ branch: 'feature/wrong', cwd: fixture.root, install: fakeInstall }),
        ).rejects.toThrow('Branch must use');
        const created = await createWorktree({
            branch: 'docs/worktrees',
            cwd: fixture.root,
            install: fakeInstall,
        });
        await writeFile(join(created.path, 'dirty.txt'), 'dirty\n', 'utf8');

        const statuses = await listWorktreeStatus(created.path);
        const status = statuses.find((candidate) => candidate.branch === 'docs/worktrees');
        expect(status).toMatchObject({
            ahead: 0,
            behind: 0,
            dependencies: 'ready',
            devProcess: 'none',
            dirty: true,
            managed: true,
        });
        expect(Object.keys(status!).sort()).toEqual([
            'ahead',
            'behind',
            'branch',
            'dependencies',
            'desktopLease',
            'detached',
            'devProcess',
            'dirty',
            'head',
            'managed',
            'path',
            'profile',
            'worktreeId',
        ]);
    });

    it('emits parseable JSON without changing the caller directory', async () => {
        const fixture = await createFixture();
        const previousCwd = process.cwd();
        const previousPath = process.env.PATH;
        const binaryDirectory = join(fixture.temporary, 'bin');
        await mkdir(binaryDirectory);
        const niPath = join(binaryDirectory, 'ni');
        await writeFile(
            niPath,
            '#!/bin/sh\nprintf "install noise\\n"\nmkdir node_modules\n',
            'utf8',
        );
        await chmod(niPath, 0o755);
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            process.chdir(fixture.root);
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            await runCli(['create', 'feat/json-output', '--json']);
        } finally {
            process.chdir(previousCwd);
            process.env.PATH = previousPath;
        }

        expect(output).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(output.mock.calls[0][0])) as {
            branch: string;
            path: string;
        };
        expect(parsed.branch).toBe('feat/json-output');
        expect(parsed.path).toContain('caxri-worktrees');
        output.mockRestore();
    });
});

describe('switch-worktree shared ownership', () => {
    it('waits for repository lock owner metadata to become visible', async () => {
        const fixture = await createFixture();
        const context = await repositoryContext(fixture.root);
        const lockPath = join(context.stateDir, 'operation.lock');
        await mkdir(lockPath, { recursive: true });
        let entered = false;
        const operation = withRepositoryLock(context, () => {
            entered = true;
            return Promise.resolve();
        });

        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        expect(entered).toBe(false);
        await rm(lockPath, { recursive: true });
        await expect(operation).resolves.toBeUndefined();
        expect(entered).toBe(true);
    });

    it('serializes repository mutations with a process identity lock', async () => {
        const fixture = await createFixture();
        const context = await repositoryContext(fixture.root);
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
            release = resolveHeld;
        });
        let entered!: () => void;
        const didEnter = new Promise<void>((resolveEntered) => {
            entered = resolveEntered;
        });
        const first = withRepositoryLock(context, async () => {
            entered();
            await held;
        });
        await didEnter;

        let secondEntered = false;
        const second = withRepositoryLock(context, () => {
            secondEntered = true;
            return Promise.resolve();
        });
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        expect(secondEntered).toBe(false);
        release();
        await first;
        await second;
        expect(secondEntered).toBe(true);

        const collision = Object.assign(new Error('task collision'), { code: 'EEXIST' });
        await expect(withRepositoryLock(context, () => Promise.reject(collision))).rejects.toThrow(
            'task collision',
        );
        await expect(withRepositoryLock(context, () => Promise.resolve('recovered'))).resolves.toBe(
            'recovered',
        );
    });

    it('assigns different profiles and a new identity when a path is recreated', async () => {
        const fixture = await createFixture();
        const first = await createWorktree({
            branch: 'feat/recreate',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const second = await createWorktree({
            branch: 'feat/parallel',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const firstDev = await prepareDevWorktree(first.path);
        const secondDev = await prepareDevWorktree(second.path);
        expect(firstDev.profile).not.toBe(secondDev.profile);
        expect(firstDev.worktreeId).not.toBe(secondDev.worktreeId);

        const oldIdentity = first.worktreeId!;
        const oldProfile = first.profile!;
        await removeWorktree({ cleanProfile: false, cwd: fixture.root, target: first.path });
        expect(await pathExists(oldProfile)).toBe(true);
        const recreated = await createWorktree({
            branch: 'feat/recreate',
            cwd: fixture.root,
            install: fakeInstall,
        });
        expect(recreated.path).toBe(first.path);
        expect(recreated.worktreeId).not.toBe(oldIdentity);
        expect(recreated.profile).not.toBe(oldProfile);
    });

    it('launches simultaneous dev wrappers with distinct userData directories', async () => {
        const fixture = await createFixture();
        const first = await createWorktree({
            branch: 'feat/dev-one',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const second = await createWorktree({
            branch: 'feat/dev-two',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const firstOutput = join(fixture.temporary, 'first-profile.txt');
        const secondOutput = join(fixture.temporary, 'second-profile.txt');
        const program =
            "require('node:fs').writeFileSync(process.argv[1], process.env.CAXRI_USER_DATA_DIR); setTimeout(() => {}, 100)";

        await Promise.all([
            devWorktree(first.path, {
                args: ['-e', program, firstOutput],
                command: process.execPath,
            }),
            devWorktree(second.path, {
                args: ['-e', program, secondOutput],
                command: process.execPath,
            }),
        ]);

        const profiles = await Promise.all([
            readFile(firstOutput, 'utf8'),
            readFile(secondOutput, 'utf8'),
        ]);
        expect(profiles[0]).not.toBe(profiles[1]);
        expect(profiles[0]).toBe(first.profile);
        expect(profiles[1]).toBe(second.profile);
    });

    it('serializes duplicate dev launches before the process record becomes observable', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'test/dev-start-lock',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const startedPath = join(fixture.temporary, 'dev-started.txt');
        const program =
            "require('node:fs').writeFileSync(process.argv[1], 'started'); setTimeout(() => {}, 200)";
        const first = devWorktree(created.path, {
            args: ['-e', program, startedPath],
            command: process.execPath,
        });
        while (!(await pathExists(startedPath))) {
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
        }

        await expect(
            devWorktree(created.path, {
                args: ['-e', '', join(fixture.temporary, 'should-not-run.txt')],
                command: process.execPath,
            }),
        ).rejects.toThrow('Development instance already running');
        await expect(first).resolves.toBe(0);
    });

    it('fails closed on an active desktop owner and reclaims a stale reused PID', async () => {
        const fixture = await createFixture();
        const other = await createWorktree({
            branch: 'test/desktop-lease',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const first = await acquireDesktopLease(fixture.root, 'Acceptance');
        activeLeases.push(first);
        const primaryStatus = (await listWorktreeStatus(fixture.root)).find(
            (status) => status.path === first.worktreePath,
        );
        expect(primaryStatus?.desktopLease).toBe('active');
        const otherStatus = (await listWorktreeStatus(other.path)).find(
            (status) => status.path === other.path,
        );
        expect(otherStatus?.desktopLease).toBe('active-other');
        expect((await doctorWorktree(other.path)).warnings).toContain(
            'desktop lease is held by another worktree',
        );
        await expect(acquireDesktopLease(other.path, 'Electron E2E')).rejects.toThrow(
            'Desktop is in use by Acceptance in',
        );

        const stored = JSON.parse(await readFile(first.leasePath, 'utf8')) as DesktopLeaseHandle;
        await writeJsonAtomic(first.leasePath, { ...stored, identity: 'reused-pid-start-time' });
        const reclaimed = await acquireDesktopLease(other.path, 'Electron E2E');
        activeLeases.push(reclaimed);
        expect(reclaimed.token).not.toBe(first.token);
        expect(reclaimed.worktreePath).toBe(other.path);
        activeLeases.splice(activeLeases.indexOf(first), 1);
    });

    it('serializes concurrent stale desktop lease reclamation', async () => {
        const fixture = await createFixture();
        const stale = await acquireDesktopLease(fixture.root, 'stale owner');
        const stored = JSON.parse(await readFile(stale.leasePath, 'utf8')) as DesktopLeaseHandle;
        await writeJsonAtomic(stale.leasePath, { ...stored, identity: 'stale-process-identity' });
        const firstEntered = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let secondEntered = false;

        const first = acquireDesktopLease(fixture.root, 'first contender', process.pid, {
            afterLockAcquired: async () => {
                firstEntered.resolve();
                await releaseFirst.promise;
            },
        });
        await firstEntered.promise;
        const second = acquireDesktopLease(fixture.root, 'second contender', process.pid, {
            afterLockAcquired: () => {
                secondEntered = true;
                return Promise.resolve();
            },
        });
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        expect(secondEntered).toBe(false);

        releaseFirst.resolve();
        const acquired = await first;
        activeLeases.push(acquired);
        await expect(second).rejects.toThrow('Desktop is in use by first contender in');
        expect(secondEntered).toBe(true);
        const persisted = JSON.parse(
            await readFile(acquired.leasePath, 'utf8'),
        ) as DesktopLeaseHandle;
        expect(persisted.token).toBe(acquired.token);
    });

    it('serializes release cleanup with a competing desktop lease acquisition', async () => {
        const fixture = await createFixture();
        const first = await acquireDesktopLease(fixture.root, 'old Electron owner');
        const releaseEntered = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<void>();
        const release = releaseDesktopLease(first, {
            afterLockAcquired: async () => {
                releaseEntered.resolve();
                await releaseCleanup.promise;
            },
        });
        await releaseEntered.promise;

        let contenderEntered = false;
        const contender = acquireDesktopLease(
            fixture.root,
            'reclaimed Electron owner',
            process.pid,
            {
                afterLockAcquired: () => {
                    contenderEntered = true;
                    return Promise.resolve();
                },
            },
        );
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        expect(contenderEntered).toBe(false);

        releaseCleanup.resolve();
        await release;
        const reclaimed = await contender;
        activeLeases.push(reclaimed);
        const persisted = JSON.parse(
            await readFile(reclaimed.leasePath, 'utf8'),
        ) as DesktopLeaseHandle;
        expect(persisted.token).toBe(reclaimed.token);
    });

    it('keeps the desktop lease active after ownership transfers to a child process', async () => {
        const fixture = await createFixture();
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
            stdio: 'ignore',
        });
        await once(child, 'spawn');
        const childPid = child.pid;
        if (!childPid) throw new Error('Test child process has no PID');
        let lease = await acquireDesktopLease(fixture.root, 'Acceptance');
        activeLeases.push(lease);

        try {
            lease = await beginDesktopLeaseHandoff(lease);
            activeLeases[activeLeases.length - 1] = lease;
            lease = await transferDesktopLease(lease, childPid);
            activeLeases[activeLeases.length - 1] = lease;
            await expect(acquireDesktopLease(fixture.root, 'Electron E2E')).rejects.toThrow(
                'Desktop is in use by Acceptance in',
            );
        } finally {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
    });

    it('fails closed when a desktop launcher dies during child handoff', async () => {
        const fixture = await createFixture();
        let lease = await acquireDesktopLease(fixture.root, 'Acceptance');
        activeLeases.push(lease);
        lease = await beginDesktopLeaseHandoff(lease);
        activeLeases[activeLeases.length - 1] = lease;
        const stored = JSON.parse(await readFile(lease.leasePath, 'utf8')) as DesktopLeaseHandle;
        await writeJsonAtomic(lease.leasePath, { ...stored, identity: 'dead-launcher-identity' });

        await expect(acquireDesktopLease(fixture.root, 'Electron E2E')).rejects.toThrow(
            'Desktop handoff from Acceptance did not complete',
        );
    });
});

describe('switch-worktree safe removal', () => {
    it('rejects dirty, unpushed, active-dev, and desktop-lease owners', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/remove-guards',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const dirtyPath = join(created.path, 'dirty.txt');
        await writeFile(dirtyPath, 'dirty\n', 'utf8');
        await expect(
            removeWorktree({ cleanProfile: false, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('dirty worktree');
        await unlink(dirtyPath);

        await writeFile(join(created.path, 'tracked.txt'), 'commit\n', 'utf8');
        await git(created.path, 'add', 'tracked.txt');
        await git(created.path, 'commit', '-m', 'unpushed');
        await expect(
            removeWorktree({ cleanProfile: false, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('unpushed commits');
        await git(created.path, 'push', '-u', 'origin', 'chore/remove-guards');

        const context = await repositoryContext(fixture.root);
        const identity = await getProcessIdentity(process.pid);
        await writeJsonAtomic(join(context.stateDir, 'processes', `${created.worktreeId}.json`), {
            identity,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token: 'test-process',
            worktreeId: created.worktreeId,
            worktreePath: created.path,
        });
        await expect(
            removeWorktree({ cleanProfile: false, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('active dev PID');
        await unlink(join(context.stateDir, 'processes', `${created.worktreeId}.json`));

        const lease = await acquireDesktopLease(created.path, 'performance benchmark');
        activeLeases.push(lease);
        await expect(
            removeWorktree({ cleanProfile: false, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('holding desktop lease');
    });

    it('preserves the branch and removes the profile only when explicitly requested', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/clean-profile',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const profile = created.profile!;
        const context = await repositoryContext(fixture.root);
        await writeJsonAtomic(join(context.stateDir, 'processes', `${created.worktreeId}.json`), {
            identity: 'stale-reused-pid',
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token: 'stale-process',
            worktreeId: created.worktreeId,
            worktreePath: created.path,
        });

        const result = await removeWorktree({
            cleanProfile: true,
            cwd: fixture.root,
            target: created.path,
        });

        expect(result).toEqual({ path: created.path, profileKept: false });
        expect(await pathExists(profile)).toBe(false);
        expect(
            (
                await git(fixture.root, 'show-ref', '--verify', 'refs/heads/chore/clean-profile')
            ).trim(),
        ).not.toBe('');
    });

    it('rejects a forged worktree identity before profile cleanup can escape its state root', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/forged-identity',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const identityPath = (
            await git(created.path, 'rev-parse', '--git-path', 'caxri-worktree-id')
        ).trim();
        const context = await repositoryContext(fixture.root);
        const sentinel = join(context.stateDir, 'profiles', '../../must-survive.txt');
        await writeFile(sentinel, 'safe\n', 'utf8');
        await writeFile(identityPath, '../../must-survive.txt\n', 'utf8');

        await expect(
            removeWorktree({ cleanProfile: true, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('Invalid worktree identity');
        expect(await readFile(sentinel, 'utf8')).toBe('safe\n');
    });

    it('refuses profile cleanup after its directory is replaced', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/profile-replacement',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const profile = created.profile!;
        const sentinelDirectory = join(fixture.temporary, 'sentinel-profile');
        await mkdir(sentinelDirectory);
        await writeFile(join(sentinelDirectory, 'keep.txt'), 'safe\n', 'utf8');
        await rm(profile, { recursive: true });
        await symlink(sentinelDirectory, profile);

        await expect(
            removeWorktree({ cleanProfile: true, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('Refusing to clean non-directory isolated profile');
        expect(await readFile(join(sentinelDirectory, 'keep.txt'), 'utf8')).toBe('safe\n');

        await unlink(profile);
        await writeFile(profile, 'not a directory\n', 'utf8');
        await expect(
            removeWorktree({ cleanProfile: true, cwd: fixture.root, target: created.path }),
        ).rejects.toThrow('Refusing to clean non-directory isolated profile');
        expect(await git(fixture.root, 'worktree', 'list', '--porcelain')).toContain(created.path);
    });
});
