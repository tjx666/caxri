import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopLeaseHandle } from './desktop-lease';
import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
} from './desktop-lease';
import { getProcessIdentity, runCapture } from './process';
import {
    isPathPresent,
    repoContext,
    withRepoLock,
    worktreeDirectory,
    writeJsonAtomic,
} from './repo';
import { runCli } from './switch-worktree';
import {
    createWorktree,
    developmentWorktree,
    doctorWorktree,
    installWorktreeDependencies,
    listWorktreeStatus,
    prepareDevelopmentWorktree,
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

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
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
    const electronDirectory = join(path, 'node_modules', 'electron');
    await mkdir(join(electronDirectory, 'dist'), { recursive: true });
    await writeFile(join(electronDirectory, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    await writeFile(join(electronDirectory, 'path.txt'), 'electron', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'version'), 'v1.0.0\n', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'electron'), 'binary', 'utf8');
}

afterEach(async () => {
    const leasesToRelease = activeLeases.slice();
    activeLeases.length = 0;
    await Promise.all(leasesToRelease.map((lease) => releaseDesktopLease(lease)));

    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
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

        const context = await repoContext(fixture.root);
        expect(created.path).toBe(worktreeDirectory(context, 'feat/example'));
        expect(basename(created.path)).toMatch(/^feat-example-[a-f0-9]{8}$/);
        expect(created.path).not.toContain('%');
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

    it('materializes existing branches under portable worktree directory names', async () => {
        const fixture = await createFixture();
        // Each iteration mutates the shared fixture repository, so the branches must be created and switched to sequentially rather than concurrently.
        /* eslint-disable no-await-in-loop -- sequential mutation of one shared git repository */
        for (const branch of ['feat/foo%2Fbar', 'feat/windows<bad>|"name"']) {
            await git(fixture.root, 'branch', branch, 'origin/main');
            const switched = await switchWorktree(fixture.root, branch, fakeInstall);
            expect(basename(switched.path)).toMatch(/^[\w.-]+$/);
            expect(basename(switched.path).toLowerCase()).not.toContain('%2f');
        }
        /* eslint-enable no-await-in-loop */
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
            orphanProcesses: [],
        });
        expect(Object.keys(status!).toSorted((left, right) => left.localeCompare(right))).toEqual([
            'ahead',
            'behind',
            'branch',
            'cdpPort',
            'dependencies',
            'desktopLease',
            'detached',
            'devProcess',
            'dirty',
            'head',
            'managed',
            'orphanProcesses',
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
            '#!/bin/sh\nprintf "install noise\\n"\nmkdir -p node_modules/electron/dist\nprintf \'{"version":"1.0.0"}\\n\' > node_modules/electron/package.json\nprintf "electron" > node_modules/electron/path.txt\nprintf "v1.0.0\\n" > node_modules/electron/dist/version\nprintf "binary" > node_modules/electron/dist/electron\n',
            'utf8',
        );
        await chmod(niPath, 0o755);
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});
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

    it('restores exact manifests without following installer-created symlinks', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-install-'));
        temporaryDirectories.push(temporary);
        const binaryDirectory = join(temporary, 'bin');
        await mkdir(binaryDirectory);
        const niPath = join(binaryDirectory, 'ni');
        await writeFile(
            niPath,
            '#!/bin/sh\nrm pnpm-lock.yaml\nln -s "$CAXRI_TEST_EXTERNAL_TARGET" pnpm-lock.yaml\nprintf "packages: []\\n" > pnpm-workspace.yaml\nmkdir -p node_modules/electron/dist\nprintf \'{"version":"1.0.0"}\\n\' > node_modules/electron/package.json\nprintf "electron" > node_modules/electron/path.txt\nprintf "v1.0.0\\n" > node_modules/electron/dist/version\nprintf "binary" > node_modules/electron/dist/electron\n',
            'utf8',
        );
        await chmod(niPath, 0o755);
        const packageSource = '{"name":"fixture"}\n';
        const lockSource = "lockfileVersion: '9.0'\n";
        const workspaceSource = "packages:\n    - 'packages/*'\n";
        const externalTarget = join(temporary, 'external-target.txt');
        await writeFile(join(temporary, 'package.json'), packageSource, 'utf8');
        await writeFile(join(temporary, 'pnpm-lock.yaml'), lockSource, 'utf8');
        await writeFile(join(temporary, 'pnpm-workspace.yaml'), workspaceSource, 'utf8');
        await writeFile(externalTarget, 'preserve external target\n', 'utf8');
        const previousPath = process.env.PATH;
        const previousExternalTarget = process.env.CAXRI_TEST_EXTERNAL_TARGET;
        try {
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            process.env.CAXRI_TEST_EXTERNAL_TARGET = externalTarget;
            await installWorktreeDependencies(temporary);
        } finally {
            process.env.PATH = previousPath;
            if (previousExternalTarget === undefined) delete process.env.CAXRI_TEST_EXTERNAL_TARGET;
            else process.env.CAXRI_TEST_EXTERNAL_TARGET = previousExternalTarget;
        }

        expect(await readFile(join(temporary, 'package.json'), 'utf8')).toBe(packageSource);
        expect(await readFile(join(temporary, 'pnpm-lock.yaml'), 'utf8')).toBe(lockSource);
        expect(await readFile(join(temporary, 'pnpm-workspace.yaml'), 'utf8')).toBe(
            workspaceSource,
        );
        expect((await lstat(join(temporary, 'pnpm-lock.yaml'))).isSymbolicLink()).toBe(false);
        expect(await readFile(externalTarget, 'utf8')).toBe('preserve external target\n');
        expect(await isPathPresent(join(temporary, 'node_modules'))).toBe(true);
    });

    it('refuses pre-existing manifest symlinks before launching ni', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-symlink-install-'));
        temporaryDirectories.push(temporary);
        const binaryDirectory = join(temporary, 'bin');
        await mkdir(binaryDirectory);
        const niPath = join(binaryDirectory, 'ni');
        const niMarker = join(temporary, 'ni-ran');
        await writeFile(niPath, '#!/bin/sh\ntouch "$CAXRI_TEST_NI_MARKER"\n', 'utf8');
        await chmod(niPath, 0o755);
        const externalTarget = join(temporary, 'external-target.txt');
        await writeFile(join(temporary, 'package.json'), '{"name":"fixture"}\n', 'utf8');
        await writeFile(externalTarget, 'preserve external target\n', 'utf8');
        await symlink(externalTarget, join(temporary, 'pnpm-lock.yaml'));
        const previousPath = process.env.PATH;
        const previousNiMarker = process.env.CAXRI_TEST_NI_MARKER;
        try {
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            process.env.CAXRI_TEST_NI_MARKER = niMarker;
            await expect(installWorktreeDependencies(temporary)).rejects.toThrow(/symbolic link/i);
        } finally {
            process.env.PATH = previousPath;
            if (previousNiMarker === undefined) delete process.env.CAXRI_TEST_NI_MARKER;
            else process.env.CAXRI_TEST_NI_MARKER = previousNiMarker;
        }

        expect((await lstat(join(temporary, 'pnpm-lock.yaml'))).isSymbolicLink()).toBe(true);
        expect(await readFile(externalTarget, 'utf8')).toBe('preserve external target\n');
        expect(await isPathPresent(niMarker)).toBe(false);
    });
});

describe('switch-worktree shared ownership', () => {
    it('waits for repository lock owner metadata to become visible', async () => {
        const fixture = await createFixture();
        const context = await repoContext(fixture.root);
        const lockPath = join(context.stateDir, 'operation.lock');
        await mkdir(lockPath, { recursive: true });
        let isEntered = false;
        const operation = withRepoLock(context, () => {
            isEntered = true;
            return Promise.resolve();
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isEntered).toBe(false);
        await rm(lockPath, { recursive: true });
        await expect(operation).resolves.toBeUndefined();
        expect(isEntered).toBe(true);
    });

    it('serializes repository mutations with a process identity lock', async () => {
        const fixture = await createFixture();
        const context = await repoContext(fixture.root);
        const held = Promise.withResolvers<void>();
        const enteredSignal = Promise.withResolvers<void>();
        const first = withRepoLock(context, async () => {
            enteredSignal.resolve();
            await held.promise;
        });
        await enteredSignal.promise;

        let isSecondEntered = false;
        const second = withRepoLock(context, () => {
            isSecondEntered = true;
            return Promise.resolve();
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isSecondEntered).toBe(false);
        held.resolve();
        await first;
        await second;
        expect(isSecondEntered).toBe(true);

        const collision = Object.assign(new Error('task collision'), { code: 'EEXIST' });
        await expect(withRepoLock(context, () => Promise.reject(collision))).rejects.toThrow(
            'task collision',
        );
        await expect(withRepoLock(context, () => Promise.resolve('recovered'))).resolves.toBe(
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
        const firstDevelopment = await prepareDevelopmentWorktree(first.path);
        const secondDevelopment = await prepareDevelopmentWorktree(second.path);
        expect(firstDevelopment.profile).not.toBe(secondDevelopment.profile);
        expect(firstDevelopment.worktreeId).not.toBe(secondDevelopment.worktreeId);

        const oldIdentity = first.worktreeId!;
        const oldProfile = first.profile!;
        await removeWorktree({ cwd: fixture.root, preserveProfile: true, target: first.path });
        expect(await isPathPresent(oldProfile)).toBe(true);
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
            developmentWorktree(first.path, {
                args: ['-e', program, firstOutput],
                command: process.execPath,
            }),
            developmentWorktree(second.path, {
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
        const releasePath = join(fixture.temporary, 'dev-release.txt');
        const program =
            "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'started'); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); } }, 10)";
        const first = developmentWorktree(created.path, {
            args: ['-e', program, startedPath, releasePath],
            command: process.execPath,
        });
        // Polls until the child process's fixture file appears; inherently sequential.
        /* eslint-disable no-await-in-loop -- sequential poll for an external side effect */
        while (!(await isPathPresent(startedPath))) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        /* eslint-enable no-await-in-loop */

        try {
            await expect(
                developmentWorktree(created.path, {
                    args: ['-e', '', join(fixture.temporary, 'should-not-run.txt')],
                    command: process.execPath,
                }),
            ).rejects.toThrow('Development instance already running');
        } finally {
            await writeFile(releasePath, 'release\n', 'utf8');
        }
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
        let isSecondEntered = false;

        const first = acquireDesktopLease(fixture.root, 'first contender', process.pid, {
            afterLockAcquired: async () => {
                firstEntered.resolve();
                await releaseFirst.promise;
            },
        });
        await firstEntered.promise;
        const second = acquireDesktopLease(fixture.root, 'second contender', process.pid, {
            afterLockAcquired: () => {
                isSecondEntered = true;
                return Promise.resolve();
            },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isSecondEntered).toBe(false);

        releaseFirst.resolve();
        const acquired = await first;
        activeLeases.push(acquired);
        await expect(second).rejects.toThrow('Desktop is in use by first contender in');
        expect(isSecondEntered).toBe(true);
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

        let isContenderEntered = false;
        const contender = acquireDesktopLease(
            fixture.root,
            'reclaimed Electron owner',
            process.pid,
            {
                afterLockAcquired: () => {
                    isContenderEntered = true;
                    return Promise.resolve();
                },
            },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isContenderEntered).toBe(false);

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
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('dirty worktree');
        await unlink(dirtyPath);

        await writeFile(join(created.path, 'tracked.txt'), 'commit\n', 'utf8');
        await git(created.path, 'add', 'tracked.txt');
        await git(created.path, 'commit', '-m', 'unpushed');
        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('changes are not preserved on origin');
        await git(created.path, 'push', '-u', 'origin', 'chore/remove-guards');

        const context = await repoContext(fixture.root);
        await writeJsonAtomic(join(context.stateDir, 'processes', `${created.worktreeId}.json`), {
            cdpPort: 9300,
            identity: await getProcessIdentity(process.pid),
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token: 'test-process',
            worktreeId: created.worktreeId,
            worktreePath: created.path,
        });
        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('active dev PID');
        await unlink(join(context.stateDir, 'processes', `${created.worktreeId}.json`));

        const lease = await acquireDesktopLease(created.path, 'performance benchmark');
        activeLeases.push(lease);
        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('holding desktop lease');
    });

    it('preserves the branch and removes the profile by default', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/clean-profile',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const context = await repoContext(fixture.root);
        const processPath = join(context.stateDir, 'processes', `${created.worktreeId}.json`);
        await writeJsonAtomic(processPath, {
            cdpPort: 9300,
            identity: 'stale-reused-pid',
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token: 'stale-process',
            worktreeId: created.worktreeId,
            worktreePath: created.path,
        });
        const result = await removeWorktree({
            cwd: fixture.root,
            preserveProfile: false,
            target: created.path,
        });
        expect(result).toEqual({ path: created.path, profileKept: false });
        expect(await isPathPresent(created.profile!)).toBe(false);
        expect(await isPathPresent(processPath)).toBe(false);
        const branch = 'refs/heads/chore/clean-profile';
        const branchReference = await git(fixture.root, 'show-ref', '--verify', branch);
        expect(branchReference.trim()).not.toBe('');
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
        const context = await repoContext(fixture.root);
        const sentinel = join(context.stateDir, 'profiles', '../../must-survive.txt');
        await writeFile(sentinel, 'safe\n', 'utf8');
        await writeFile(identityPath, '../../must-survive.txt\n', 'utf8');

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
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
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('Refusing to clean non-directory isolated profile');
        expect(await readFile(join(sentinelDirectory, 'keep.txt'), 'utf8')).toBe('safe\n');

        await unlink(profile);
        await writeFile(profile, 'not a directory\n', 'utf8');
        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('Refusing to clean non-directory isolated profile');
        expect(await git(fixture.root, 'worktree', 'list', '--porcelain')).toContain(created.path);
    });
});
