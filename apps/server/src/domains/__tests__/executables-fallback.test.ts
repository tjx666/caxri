import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExecutableResolver, wellKnownExecutableDirectories } from '../executables';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

function loginShellOutput(path: string): string {
    return `banner\n__CAXRI_LOGIN_PATH__${path}\n__CAXRI_LOGIN_ENV_START____CAXRI_LOGIN_ENV_END__`;
}

describe('ExecutableResolver well-known directory fallback', () => {
    async function installFixture(home: string, relativeDirectory: string): Promise<string> {
        const directory = join(home, relativeDirectory);
        await mkdir(directory, { recursive: true });
        const executable = join(directory, 'caxri-fixture-agent');
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
        return executable;
    }

    it('lists the install directories in search order', () => {
        expect(wellKnownExecutableDirectories('/home/user')).toEqual([
            '/home/user/.local/bin',
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/home/user/.claude/local',
            '/home/user/.bun/bin',
        ]);
    });

    it.each([
        [
            'a timed-out',
            () => Promise.reject(Object.assign(new Error('timed out'), { killed: true })),
        ],
        ['a failed', () => Promise.reject(Object.assign(new Error('exit 1'), { code: 1 }))],
        ['a markerless', () => Promise.resolve({ stdout: 'banner only\n', stderr: '' })],
    ])('still finds a CLI in a well-known directory after %s login probe', async (_probe, run) => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-executable-fallback-'));
        temporaryDirectories.push(home);
        const executable = await installFixture(home, '.claude/local');
        const resolver = new ExecutableResolver(
            () => ({ HOME: home, PATH: '/nonexistent-caxri-bin', SHELL: '/bin/zsh' }),
            run,
        );

        await expect(resolver.resolve('caxri-fixture-agent')).resolves.toBe(executable);
    });

    it('prefers the earlier well-known directory and never overrides PATH', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-executable-order-'));
        temporaryDirectories.push(home);
        await installFixture(home, '.bun/bin');
        const preferred = await installFixture(home, '.local/bin');
        const pathBin = join(home, 'path-bin');
        const onPath = await installFixture(home, 'path-bin');
        const run = () => Promise.reject(new Error('no shell'));
        const withoutPath = new ExecutableResolver(
            () => ({ HOME: home, PATH: '/nonexistent-caxri-bin', SHELL: '/bin/zsh' }),
            run,
        );
        await expect(withoutPath.resolve('caxri-fixture-agent')).resolves.toBe(preferred);
        const withPath = new ExecutableResolver(
            () => ({ HOME: home, PATH: pathBin, SHELL: '/bin/zsh' }),
            run,
        );
        await expect(withPath.resolve('caxri-fixture-agent')).resolves.toBe(onPath);
    });

    it('does not search well-known directories when the login probe succeeded', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-executable-hermetic-'));
        temporaryDirectories.push(home);
        await installFixture(home, '.local/bin');
        const resolver = new ExecutableResolver(
            () => ({ HOME: home, PATH: '/nonexistent-caxri-bin', SHELL: '/bin/sh' }),
            () =>
                Promise.resolve({
                    stdout: loginShellOutput('/nonexistent-login-bin'),
                    stderr: '',
                }),
        );
        await expect(resolver.resolve('caxri-fixture-agent')).resolves.toBeUndefined();
    });

    it('adds the directory of a fallback-resolved CLI to the spawn PATH', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-executable-fallback-path-'));
        temporaryDirectories.push(home);
        const executable = await installFixture(home, '.local/bin');
        const resolver = new ExecutableResolver(
            () => ({ HOME: home, PATH: '/nonexistent-caxri-bin', SHELL: '/bin/zsh' }),
            () => Promise.reject(new Error('no shell')),
        );
        await expect(resolver.resolve('caxri-fixture-agent')).resolves.toBe(executable);
        const directory = join(home, '.local/bin');
        expect((await resolver.agentEnvironment()).PATH).toBe(
            `/nonexistent-caxri-bin:${directory}`,
        );
        expect((await resolver.environment()).PATH).toBe(`/nonexistent-caxri-bin:${directory}`);
    });

    it('still reports a CLI missing when no directory has it', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-executable-missing-'));
        temporaryDirectories.push(home);
        const resolver = new ExecutableResolver(
            () => ({ HOME: home, PATH: '/nonexistent-caxri-bin', SHELL: '/bin/zsh' }),
            () => Promise.reject(new Error('no shell')),
        );
        await expect(resolver.resolve('caxri-fixture-agent')).resolves.toBeUndefined();
    });
});
