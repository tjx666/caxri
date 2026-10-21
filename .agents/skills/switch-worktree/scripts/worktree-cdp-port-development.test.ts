import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCapture } from './process';
import { isPathPresent } from './repo';
import { createWorktree, developmentWorktree, listWorktreeStatus } from './worktree';
import { CDP_PORT_BASE, CDP_PORT_RANGE } from './worktree-cdp-port';

/**
 * Split out of `switch-worktree.test.ts`, which already sits at the repository's `max-lines` cap: these cases exercise
 * the per-worktree CDP port `switch-worktree dev` resolves (issue caxri#1016), separately from that file's broader
 * command coverage.
 */

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createFixture(): Promise<{ root: string; temporary: string }> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-cdp-port-'));
    temporaryDirectories.push(temporary);
    const remote = join(temporary, 'remote.git');
    const root = join(temporary, 'caxri');
    await mkdir(root);
    await git(temporary, 'init', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-u', 'origin', 'main');
    await mkdir(join(root, 'node_modules'));
    return { root, temporary };
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
    vi.unstubAllEnvs();
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('per-worktree CDP port', () => {
    it('gives simultaneous dev wrappers distinct, in-range CDP ports', async () => {
        const fixture = await createFixture();
        const first = await createWorktree({
            branch: 'feat/cdp-one',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const second = await createWorktree({
            branch: 'feat/cdp-two',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const firstOutput = join(fixture.temporary, 'first-cdp-port.txt');
        const secondOutput = join(fixture.temporary, 'second-cdp-port.txt');
        const program =
            "require('node:fs').writeFileSync(process.argv[1], process.env.CAXRI_DEV_CDP_PORT); setTimeout(() => {}, 100)";

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

        const [firstPort, secondPort] = await Promise.all([
            readFile(firstOutput, 'utf8'),
            readFile(secondOutput, 'utf8'),
        ]);
        expect(firstPort).not.toBe(secondPort);
        for (const port of [Number(firstPort), Number(secondPort)]) {
            expect(port).toBeGreaterThanOrEqual(CDP_PORT_BASE);
            expect(port).toBeLessThan(CDP_PORT_BASE + CDP_PORT_RANGE);
        }
    });

    it('reports the active dev instance CDP port through list status', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'test/cdp-port-list',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const startedPath = join(fixture.temporary, 'cdp-port-list-started.txt');
        const releasePath = join(fixture.temporary, 'cdp-port-list-release.txt');
        const program =
            "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'started'); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); } }, 10)";
        const launch = developmentWorktree(created.path, {
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
            const status = (await listWorktreeStatus(fixture.root)).find(
                (entry) => entry.path === created.path,
            );
            expect(status?.devProcess).toBe('active');
            expect(status?.cdpPort).toBeGreaterThanOrEqual(CDP_PORT_BASE);
            expect(status?.cdpPort).toBeLessThan(CDP_PORT_BASE + CDP_PORT_RANGE);
        } finally {
            await writeFile(releasePath, 'release\n', 'utf8');
        }
        await expect(launch).resolves.toBe(0);
    });
});

describe('dev launch profile', () => {
    const program =
        "require('node:fs').writeFileSync(process.argv[1], process.env.CAXRI_USER_DATA_DIR)";

    it('ignores an inherited CAXRI_USER_DATA_DIR, which Agent Terminals point at the installed app', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'test/dev-inherited-profile',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const output = join(fixture.temporary, 'inherited-profile.txt');
        vi.stubEnv('CAXRI_USER_DATA_DIR', join(fixture.temporary, 'installed-app-profile'));

        await developmentWorktree(created.path, {
            args: ['-e', program, output],
            command: process.execPath,
        });

        expect(await readFile(output, 'utf8')).toBe(created.profile);
    });

    it('launches against an explicit --user-data-dir and reports that directory', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'test/dev-explicit-profile',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const output = join(fixture.temporary, 'explicit-profile.txt');
        const explicit = join(fixture.temporary, 'fixture-profile');
        const reported: string[] = [];

        await developmentWorktree(created.path, {
            args: ['-e', program, output],
            command: process.execPath,
            onLaunch: (info) => reported.push(info.profile),
            userDataDirectory: explicit,
        });

        expect(await readFile(output, 'utf8')).toBe(explicit);
        expect(reported).toEqual([explicit]);
    });
});
