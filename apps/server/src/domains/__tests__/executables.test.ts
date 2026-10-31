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

        await expect(resolver.resolve('caxri-fixture-cli')).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledOnce();

        const executable = join(newBin, 'caxri-fixture-cli');
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
        loginPath = newBin;

        now += 1_000;
        await expect(resolver.resolve('caxri-fixture-cli')).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledOnce();

        now += 60_000;
        await expect(resolver.resolve('caxri-fixture-cli')).resolves.toBe(executable);
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

    /**
     * `warmServerExecutablePath` (issue #1345) fires `environment()` without awaiting it during Server startup so the
     * login-shell PATH probe is already in flight before the first real external command needs it. This proves the
     * mechanism it relies on: an unawaited call still starts and memoizes the same login-shell request a later, awaited
     * call reuses, instead of each call spawning its own shell.
     */
    it('lets an unawaited warm-up call start the login-shell probe that a later call reuses', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-warmup-'));
        temporaryDirectories.push(directory);
        const loginBin = join(directory, 'login-bin');
        await mkdir(loginBin);
        const run = vi.fn(() =>
            Promise.resolve({ stdout: `__CAXRI_LOGIN_PATH__${loginBin}\n`, stderr: '' }),
        );
        const resolver = new ExecutableResolver(
            () => ({ HOME: directory, PATH: '/nonexistent', SHELL: '/bin/zsh' }),
            run,
        );

        // Fire-and-forget, exactly how `warmServerExecutablePath` calls it: the caller never awaits this promise.
        void resolver.environment();

        await expect(resolver.environment()).resolves.toEqual(
            expect.objectContaining({ PATH: loginBin }),
        );
        expect(run).toHaveBeenCalledOnce();
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

function loginShellOutput(path: string, variables: Record<string, string>): string {
    const environment = Object.entries(variables)
        .map(([key, value]) => `${key}=${value}\0`)
        .join('');
    return `banner\n__CAXRI_LOGIN_PATH__${path}\n__CAXRI_LOGIN_ENV_START__${environment}__CAXRI_LOGIN_ENV_END__`;
}

describe('ExecutableResolver Agent environment', () => {
    it('gives Agents the login-shell variables under the allowlisted launch context', async () => {
        const run = vi.fn(() =>
            Promise.resolve({
                stdout: loginShellOutput('/login/bin', {
                    SEARCH_API_KEY: 'from-startup-file',
                    MULTILINE_VALUE: 'first\nsecond=line',
                    CODEX_HOME: '/startup-file/codex',
                    PATH: '/login/bin',
                    PWD: '/probe-cwd',
                    OLDPWD: '/probe-previous',
                    SHLVL: '2',
                    _: '/usr/bin/env',
                    CAXRI_AGENT_ENDPOINT: 'stale-from-startup-file',
                }),
                stderr: '',
            }),
        );
        const resolver = new ExecutableResolver(
            () => ({
                HOME: '/home/user',
                PATH: '/usr/bin:/bin',
                SHELL: '/bin/zsh',
                CODEX_HOME: '/isolated/codex',
                GITHUB_TOKEN: 'must-not-leak',
            }),
            run,
        );

        const agentEnvironment = await resolver.agentEnvironment();

        expect(agentEnvironment).toMatchObject({
            SEARCH_API_KEY: 'from-startup-file',
            MULTILINE_VALUE: 'first\nsecond=line',
            CODEX_HOME: '/isolated/codex',
            HOME: '/home/user',
            PATH: '/login/bin',
        });
        for (const key of ['PWD', 'OLDPWD', 'SHLVL', '_', 'CAXRI_AGENT_ENDPOINT', 'GITHUB_TOKEN'])
            expect(agentEnvironment).not.toHaveProperty(key);
        const serverEnvironment = await resolver.environment();
        expect(serverEnvironment).not.toHaveProperty('SEARCH_API_KEY');
        expect(serverEnvironment).toMatchObject({ PATH: '/login/bin' });
        expect(run).toHaveBeenCalledOnce();
    });

    it('serves a stale snapshot to Agent launches while one background probe refreshes it', async () => {
        let output = loginShellOutput('/login/bin', { SEARCH_API_KEY: 'first' });
        let isFails = false;
        const refresh = Promise.withResolvers<void>();
        const run = vi.fn(async () => {
            if (isFails) throw Object.assign(new Error('login shell timed out'), { killed: true });
            const stdout = output;
            if (run.mock.calls.length > 1) await refresh.promise;
            return { stdout, stderr: '' };
        });
        let now = 1_000_000;
        const resolver = new ExecutableResolver(
            () => ({ HOME: '/home/user', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }),
            run,
            () => now,
        );

        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'first',
        });
        output = loginShellOutput('/login/bin', { SEARCH_API_KEY: 'second' });
        now += 1_000;
        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'first',
        });
        expect(run).toHaveBeenCalledOnce();

        // Past the refresh age, launches answer from the old snapshot while the new probe is still running.
        now += 60_000;
        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'first',
        });
        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'first',
        });
        expect(run).toHaveBeenCalledTimes(2);
        refresh.resolve();
        await vi.waitFor(async () => {
            await expect(resolver.agentEnvironment()).resolves.toMatchObject({
                SEARCH_API_KEY: 'second',
            });
        });
        expect(run).toHaveBeenCalledTimes(2);

        isFails = true;
        now += 60_000;
        await resolver.agentEnvironment();
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'second',
            PATH: '/login/bin',
        });
    });

    // A stopped Server Core detaches its logger; a probe still running must not append into that Core's `logs/`.
    it('drops the record of a probe that finishes after its logger detached, and keeps a newer logger', async () => {
        const probe = Promise.withResolvers<{ stderr: string; stdout: string }>();
        const resolver = new ExecutableResolver(
            () => ({ HOME: '/home/user', PATH: '/usr/bin', SHELL: '/bin/zsh' }),
            () => probe.promise,
        );
        const stopped = vi.fn();
        const next = vi.fn();
        const detachStopped = resolver.attachLogger({ write: stopped });
        const environment = resolver.agentEnvironment();
        detachStopped();
        probe.resolve({ stdout: loginShellOutput('/login/bin', {}), stderr: '' });
        await environment;
        expect(stopped).not.toHaveBeenCalled();

        const detachNext = resolver.attachLogger({ write: next });
        detachStopped();
        resolver.clear();
        await resolver.agentEnvironment();
        expect(next).toHaveBeenCalledWith('info', 'login_shell.probe', expect.anything());
        detachNext();
    });

    it('logs each probe failure by cause and counts dropped variables without naming them', async () => {
        const write = vi.fn();
        const failures: Array<[unknown, string]> = [
            [Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), 'timeout'],
            [Object.assign(new Error('exit 1'), { code: 1 }), 'exit'],
            [
                Object.assign(new Error('too much'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
                'output_limit',
            ],
            [{ stdout: 'only a banner\n' }, 'missing_markers'],
            [{ stdout: '__CAXRI_LOGIN_PATH__relative/bin\n' }, 'missing_path'],
        ];
        for (const [result, reason] of failures) {
            const resolver = new ExecutableResolver(
                () => ({ HOME: '/home/user', PATH: '/usr/bin', SHELL: '/bin/zsh' }),
                () =>
                    result instanceof Error
                        ? Promise.reject(result)
                        : Promise.resolve({ stderr: '', ...(result as { stdout: string }) }),
            );
            resolver.attachLogger({ write });
            // eslint-disable-next-line no-await-in-loop -- each resolver logs one probe in order
            await resolver.agentEnvironment();
            expect(write).toHaveBeenLastCalledWith(
                'warn',
                'login_shell.probe',
                expect.objectContaining({ fields: { outcome: 'failed', reason } }),
            );
        }

        const many = Object.fromEntries(
            Array.from({ length: 390 }, (_, index) => [`TOOL_VARIABLE_${index}`, 'value']),
        );
        const resolver = new ExecutableResolver(
            () => ({ HOME: '/home/user', PATH: '/usr/bin', SHELL: '/bin/zsh' }),
            () =>
                Promise.resolve({
                    stdout: loginShellOutput('/login/bin', {
                        'SECRET_FIXTURE_NAME': 'secret-fixture-value',
                        'HUGE_VALUE': 'x'.repeat(64 * 1024 + 1),
                        [`LONG_${'N'.repeat(256)}`]: 'value',
                        'BAD-NAME': 'value',
                        'PWD': '/probe',
                        'CAXRI_ENDPOINT': 'value',
                        ...many,
                    }),
                    stderr: '',
                }),
        );
        resolver.attachLogger({ write });
        await resolver.agentEnvironment();

        expect(write).toHaveBeenLastCalledWith('info', 'login_shell.probe', {
            durationMs: expect.any(Number) as number,
            fields: {
                outcome: 'read',
                environment: 'parsed',
                variables: 384,
                dropped_caxri_key: 1,
                dropped_entry_limit: 7,
                dropped_invalid_name: 1,
                dropped_name_too_long: 1,
                dropped_session_key: 1,
                dropped_value_too_long: 1,
            },
        });
        const logged = JSON.stringify(write.mock.calls);
        expect(logged).not.toContain('SECRET_FIXTURE_NAME');
        expect(logged).not.toContain('secret-fixture-value');
    });

    it('starts one login-shell probe for concurrently invalidated cached executables', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-executable-concurrent-'));
        temporaryDirectories.push(directory);
        const firstBin = join(directory, 'first');
        const secondBin = join(directory, 'second');
        await mkdir(firstBin);
        await mkdir(secondBin);
        const names = ['claude', 'codex', 'grok'];
        for (const bin of [firstBin, secondBin])
            for (const name of names) {
                // eslint-disable-next-line no-await-in-loop -- tiny fixture setup
                await writeFile(join(bin, name), '#!/bin/sh\n');
                // eslint-disable-next-line no-await-in-loop -- tiny fixture setup
                await chmod(join(bin, name), 0o700);
            }
        let loginBin = firstBin;
        // A real login shell takes a while to start, which is what lets the invalidated lookups overlap.
        const run = vi.fn(async () => {
            const stdout = `__CAXRI_LOGIN_PATH__${loginBin}\n`;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { stdout, stderr: '' };
        });
        const resolver = new ExecutableResolver(
            () => ({ PATH: '/nonexistent', SHELL: '/bin/zsh' }),
            run,
        );
        for (const name of names)
            // eslint-disable-next-line no-await-in-loop -- populate the cache in order
            await expect(resolver.resolve(name)).resolves.toBe(join(firstBin, name));
        expect(run).toHaveBeenCalledOnce();

        await rm(firstBin, { recursive: true });
        loginBin = secondBin;
        await expect(Promise.all(names.map((name) => resolver.resolve(name)))).resolves.toEqual(
            names.map((name) => join(secondBin, name)),
        );
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('keeps a heavy shell environment inside the Terminal launch-plan limits', async () => {
        const many = Object.fromEntries(
            Array.from({ length: 600 }, (_, index) => [`TOOL_VARIABLE_${index}`, 'value']),
        );
        const resolver = new ExecutableResolver(
            () => ({ HOME: '/home/user', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }),
            () =>
                Promise.resolve({
                    stdout: loginShellOutput('/login/bin', {
                        HUGE_VALUE: 'x'.repeat(64 * 1024 + 1),
                        [`LONG_${'N'.repeat(256)}`]: 'value',
                        KEPT_FIRST: 'value',
                        ...many,
                    }),
                    stderr: '',
                }),
        );

        const environment = await resolver.agentEnvironment();

        expect(environment).not.toHaveProperty('HUGE_VALUE');
        expect(environment).not.toHaveProperty(`LONG_${'N'.repeat(256)}`);
        expect(environment).toHaveProperty('KEPT_FIRST');
        // Room remains under the 512-entry launch-plan schema for Caxri's own launch variables.
        expect(Object.keys(environment).length).toBeLessThanOrEqual(400);
    });

    it('falls back to the PATH marker when the shell prints no environment block', async () => {
        const resolver = new ExecutableResolver(
            () => ({ HOME: '/home/user', PATH: '/usr/bin:/bin', SHELL: '/bin/sh' }),
            () => Promise.resolve({ stdout: '__CAXRI_LOGIN_PATH__/login/bin\n', stderr: '' }),
        );

        await expect(resolver.agentEnvironment()).resolves.toEqual({
            HOME: '/home/user',
            PATH: '/login/bin',
            SHELL: '/bin/sh',
        });
    });

    it('reads variables a real login shell exports from its startup file', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-login-environment-'));
        temporaryDirectories.push(home);
        await writeFile(
            join(home, '.bash_profile'),
            "echo 'startup banner'\nexport SEARCH_API_KEY=from-bash-profile\nexport MULTILINE_VALUE=$'first\\nsecond'\n",
        );
        const resolver = new ExecutableResolver(() => ({
            HOME: home,
            PATH: '/usr/bin:/bin',
            SHELL: '/bin/bash',
        }));

        await expect(resolver.agentEnvironment()).resolves.toMatchObject({
            SEARCH_API_KEY: 'from-bash-profile',
            MULTILINE_VALUE: 'first\nsecond',
            HOME: home,
        });
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
