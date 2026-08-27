import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ExecutablesModule from '../../executables';

const mocks = vi.hoisted(() => ({
    resolveServerExecutable: vi.fn<(name: string) => Promise<string | undefined>>(),
    clearServerExecutableCache: vi.fn(),
    serverProcessEnvironment: vi.fn<() => Promise<NodeJS.ProcessEnv>>(() =>
        Promise.resolve(process.env),
    ),
}));

vi.mock('../../executables', async (importOriginal) => {
    const actual = await importOriginal<typeof ExecutablesModule>();
    /**
     * Keep the real `runExternalCommand` (it must actually spawn the version scripts below) but route its environment
     * through the mock so no test ever launches a real login shell.
     */
    const runExternalCommand: typeof actual.runExternalCommand = (
        name,
        arguments_,
        options,
        dependencies = {},
    ) =>
        actual.runExternalCommand(name, arguments_, options, {
            environment: mocks.serverProcessEnvironment,
            ...dependencies,
        });
    return {
        ...actual,
        resolveServerExecutable: mocks.resolveServerExecutable,
        clearServerExecutableCache: mocks.clearServerExecutableCache,
        serverProcessEnvironment: mocks.serverProcessEnvironment,
        runExternalCommand,
    };
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearExecutableCache, discoverExecutable, readVersion } from '../discovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    // Reset in-flight/version caches before resetting the mocks so this cleanup call itself is
    // never recorded against the next test's assertions on `mocks.clearServerExecutableCache`.
    clearExecutableCache();
    mocks.resolveServerExecutable.mockReset();
    mocks.clearServerExecutableCache.mockReset();
    mocks.serverProcessEnvironment.mockReset();
    mocks.serverProcessEnvironment.mockResolvedValue(process.env);
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

async function writeVersionScript(
    directory: string,
    name: string,
    version: string,
): Promise<string> {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\necho "${version}"\n`, 'utf8');
    await chmod(path, 0o700);
    return path;
}

describe('discoverExecutable', () => {
    it('coalesces concurrent requests for the same provider and executable into one resolution', async () => {
        const deferred = Promise.withResolvers<string | undefined>();
        mocks.resolveServerExecutable.mockReturnValue(deferred.promise);

        const first = discoverExecutable('codex', '/opt/tools/codex');
        const second = discoverExecutable('codex', '/opt/tools/codex');
        expect(mocks.resolveServerExecutable).toHaveBeenCalledTimes(1);

        deferred.resolve('/resolved/codex');
        await expect(first).resolves.toBe('/resolved/codex');
        await expect(second).resolves.toBe('/resolved/codex');
    });

    it('does not coalesce requests for different requested executables', async () => {
        const deferredA = Promise.withResolvers<string | undefined>();
        const deferredB = Promise.withResolvers<string | undefined>();
        mocks.resolveServerExecutable.mockImplementation((name: string) =>
            name === '/opt/tools/codex-a' ? deferredA.promise : deferredB.promise,
        );

        const first = discoverExecutable('codex', '/opt/tools/codex-a');
        const second = discoverExecutable('codex', '/opt/tools/codex-b');
        expect(mocks.resolveServerExecutable).toHaveBeenCalledTimes(2);

        deferredA.resolve('/resolved/a');
        deferredB.resolve('/resolved/b');
        await expect(first).resolves.toBe('/resolved/a');
        await expect(second).resolves.toBe('/resolved/b');
    });

    it('issues a fresh resolution for each call once the previous one has settled', async () => {
        mocks.resolveServerExecutable.mockResolvedValueOnce('/resolved/first');
        mocks.resolveServerExecutable.mockResolvedValueOnce('/resolved/second');

        await expect(discoverExecutable('codex', '/opt/tools/codex')).resolves.toBe(
            '/resolved/first',
        );
        await expect(discoverExecutable('codex', '/opt/tools/codex')).resolves.toBe(
            '/resolved/second',
        );
        expect(mocks.resolveServerExecutable).toHaveBeenCalledTimes(2);
    });
});

describe('clearExecutableCache', () => {
    it('delegates to the shared runtime executable cache', () => {
        clearExecutableCache();

        expect(mocks.clearServerExecutableCache).toHaveBeenCalledOnce();
    });
});

describe('readVersion', () => {
    it('caches a resolved version for the same executable path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-version-'));
        temporaryDirectories.push(directory);
        const executable = await writeVersionScript(directory, 'codex', '1.0.0');

        await expect(readVersion('codex', executable)).resolves.toBe('1.0.0');
        // Overwrite the script after the first read; a cache hit must not observe this change.
        await writeVersionScript(directory, 'codex', '9.9.9');

        await expect(readVersion('codex', executable)).resolves.toBe('1.0.0');
    });

    it('invalidates the cached version when the executable identity changes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-version-swap-'));
        temporaryDirectories.push(directory);
        const first = await writeVersionScript(directory, 'codex-a', '1.0.0');
        const second = await writeVersionScript(directory, 'codex-b', '2.0.0');

        await expect(readVersion('codex', first)).resolves.toBe('1.0.0');
        await expect(readVersion('codex', second)).resolves.toBe('2.0.0');
    });

    it('re-reads the version after clearExecutableCache resets the version cache', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-version-clear-'));
        temporaryDirectories.push(directory);
        const executable = await writeVersionScript(directory, 'codex', '1.0.0');

        await expect(readVersion('codex', executable)).resolves.toBe('1.0.0');
        await writeVersionScript(directory, 'codex', '9.9.9');
        clearExecutableCache();

        await expect(readVersion('codex', executable)).resolves.toBe('9.9.9');
    });

    it('returns undefined when the executable fails to report a version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-version-fail-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'broken');
        await writeFile(executable, '#!/bin/sh\nexit 1\n', 'utf8');
        await chmod(executable, 0o700);

        await expect(readVersion('codex', executable)).resolves.toBeUndefined();
    });
});
