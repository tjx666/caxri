import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutableResolver } from '../executables';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
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

        for (const name of names) await resolver.resolve(name);
        const directExecutable = join(directBin, names[0]);
        await writeFile(directExecutable, '#!/bin/sh\n');
        await chmod(directExecutable, 0o700);
        sourcePath = directBin;

        await expect(resolver.resolve(names[0])).resolves.toBe(directExecutable);
    });
});
