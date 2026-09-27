import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutableResolver, runExternalCommand } from '../executables';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ExecutableResolver', () => {
    it('resolves user-installed executables from a bounded login PATH and filters the environment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-resolver-'));
        temporaryDirectories.push(directory);
        const loginBin = join(directory, 'login-bin');
        const sourceBin = join(directory, 'source-bin');
        await mkdir(loginBin);
        await mkdir(sourceBin);
        const executable = join(loginBin, 'codex');
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
        const run = vi.fn(() =>
            Promise.resolve({
                stdout: `shell startup noise\n__CAXRI_LOGIN_PATH__${loginBin}:${sourceBin}\n`,
                stderr: '',
            }),
        );
        const resolver = new ExecutableResolver(
            () => ({
                HOME: directory,
                PATH: sourceBin,
                SHELL: '/bin/zsh',
                GITHUB_TOKEN: 'must-not-leak',
                CAXRI_E2E: 'must-not-leak',
            }),
            run,
        );

        await expect(resolver.resolve('codex')).resolves.toBe(executable);
        await expect(resolver.resolve('codex')).resolves.toBe(executable);
        await expect(resolver.environment()).resolves.toEqual(
            expect.objectContaining({ HOME: directory, PATH: `${loginBin}:${sourceBin}` }),
        );
        expect(await resolver.environment()).not.toHaveProperty('GITHUB_TOKEN');
        expect(await resolver.environment()).not.toHaveProperty('CAXRI_E2E');
        expect(run).toHaveBeenCalledOnce();
    });

    it('re-reads a stale login PATH when an executable is installed into a new directory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-refresh-'));
        temporaryDirectories.push(directory);
        const newBin = join(directory, 'new-bin');
        await mkdir(newBin);
        let loginPath = join(directory, 'old-bin');
        const run = vi.fn(() =>
            Promise.resolve({ stdout: `__CAXRI_LOGIN_PATH__${loginPath}\n`, stderr: '' }),
        );
        let now = 1_000_000;
        const resolver = new ExecutableResolver(
            () => ({ HOME: directory, PATH: '/nonexistent', SHELL: '/bin/zsh' }),
            run,
            () => now,
        );

        await expect(resolver.resolve('gh')).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledOnce();

        const executable = join(newBin, 'gh');
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
        loginPath = newBin;

        now += 1_000;
        await expect(resolver.resolve('gh')).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledOnce();

        now += 60_000;
        await expect(resolver.resolve('gh')).resolves.toBe(executable);
        expect(run).toHaveBeenCalledTimes(2);
        await expect(resolver.environment()).resolves.toEqual(
            expect.objectContaining({ PATH: newBin }),
        );
    });

    it('gives a caller-supplied environment the same login PATH the Server itself uses', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-caller-env-'));
        temporaryDirectories.push(directory);
        const loginBin = join(directory, 'login-bin');
        await mkdir(loginBin);
        const run = vi.fn(() =>
            Promise.resolve({ stdout: `__CAXRI_LOGIN_PATH__${loginBin}\n`, stderr: '' }),
        );
        const resolver = new ExecutableResolver(
            () => ({ HOME: directory, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }),
            run,
        );

        // A GUI-launched Server Core only sees macOS's launchd PATH, which has no Homebrew, pnpm, or mise directory.
        // An Agent CLI installed as a `/bin/sh` shim that `exec node` cannot start under it.
        const agentEnvironment = await resolver.environment({
            HOME: '/agent-home',
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            GITHUB_TOKEN: 'must-not-leak',
        });

        expect(agentEnvironment).toMatchObject({ HOME: '/agent-home', PATH: loginBin });
        expect(agentEnvironment).not.toHaveProperty('GITHUB_TOKEN');
    });

    it('rejects relative paths and revalidates a stale cached executable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-stale-'));
        temporaryDirectories.push(directory);
        const firstBin = join(directory, 'first');
        const secondBin = join(directory, 'second');
        const sourceBin = join(directory, 'source');
        const executableName = 'caxri-stale-test-executable';
        await mkdir(firstBin);
        await mkdir(secondBin);
        await mkdir(sourceBin);
        const first = join(firstBin, executableName);
        const second = join(secondBin, executableName);
        await writeFile(first, '#!/bin/sh\n');
        await writeFile(second, '#!/bin/sh\n');
        await chmod(first, 0o700);
        await chmod(second, 0o700);
        let loginBin = firstBin;
        const resolver = new ExecutableResolver(
            () => ({ PATH: sourceBin, SHELL: '/bin/zsh' }),
            () =>
                Promise.resolve({
                    stdout: `__CAXRI_LOGIN_PATH__${loginBin}\n`,
                    stderr: '',
                }),
        );

        await expect(resolver.resolve(`../${executableName}`)).resolves.toBeUndefined();
        await expect(resolver.resolve(executableName)).resolves.toBe(first);
        await rm(first);
        loginBin = secondBin;
        await expect(resolver.resolve(executableName)).resolves.toBe(second);
    });

    it('bounds cached executable names with least-recently-used eviction', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-cache-'));
        temporaryDirectories.push(directory);
        const loginBin = join(directory, 'login');
        const directBin = join(directory, 'direct');
        await Promise.all([mkdir(loginBin), mkdir(directBin)]);
        const names = Array.from({ length: 33 }, (_, index) => `command-${index}`);
        await Promise.all(
            names.map(async (name) => {
                const executable = join(loginBin, name);
                await writeFile(executable, '#!/bin/sh\n');
                await chmod(executable, 0o700);
            }),
        );
        let sourcePath = '/usr/bin';
        const resolver = new ExecutableResolver(
            () => ({ PATH: sourcePath, SHELL: '/bin/zsh' }),
            () =>
                Promise.resolve({
                    stdout: `__CAXRI_LOGIN_PATH__${loginBin}\n`,
                    stderr: '',
                }),
        );

        // eslint-disable-next-line no-await-in-loop -- LRU eviction is order-dependent; resolving concurrently would not exercise least-recently-used ordering.
        for (const name of names) await resolver.resolve(name);
        const directExecutable = join(directBin, names[0]);
        await writeFile(directExecutable, '#!/bin/sh\n');
        await chmod(directExecutable, 0o700);
        sourcePath = directBin;

        await expect(resolver.resolve(names[0])).resolves.toBe(directExecutable);
    });
});

describe('runExternalCommand', () => {
    /**
     * Regression for the packaged-app "GitHub CLI is not available on PATH" failure: a GUI launch inherits the
     * constrained launchd PATH, so external CLIs must resolve through the login-shell boundary instead of being spawned
     * as bare names.
     */
    it('spawns the resolved executable with the login-shell environment plus overrides', async () => {
        const run = vi.fn(() => Promise.resolve({ stdout: 'pr-json', stderr: '' }));
        await expect(
            runExternalCommand(
                'gh',
                ['pr', 'view'],
                { cwd: '/repo', timeout: 1_000, maxBuffer: 1_024, env: { LC_ALL: 'C' } },
                {
                    resolveExecutable: (name) => Promise.resolve(`/login/bin/${name}`),
                    environment: () =>
                        Promise.resolve({ HOME: '/home/user', PATH: '/login/bin:/usr/bin' }),
                    run,
                },
            ),
        ).resolves.toEqual({ stdout: 'pr-json', stderr: '' });
        expect(run).toHaveBeenCalledExactlyOnceWith('/login/bin/gh', ['pr', 'view'], {
            cwd: '/repo',
            env: { HOME: '/home/user', PATH: '/login/bin:/usr/bin', LC_ALL: 'C' },
            maxBuffer: 1_024,
            timeout: 1_000,
        });
    });

    it('throws an ENOENT-coded error when the executable cannot be resolved', async () => {
        const run = vi.fn(() => Promise.resolve({ stdout: '', stderr: '' }));
        await expect(
            runExternalCommand(
                'gh',
                [],
                { timeout: 1_000, maxBuffer: 1_024 },
                { resolveExecutable: () => Promise.resolve(undefined), run },
            ),
        ).rejects.toMatchObject({ code: 'ENOENT', message: 'gh was not found' });
        expect(run).not.toHaveBeenCalled();
    });
});
