import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveRuntimeExecutable: vi.fn<(name: string) => Promise<string | undefined>>(),
    clearRuntimeExecutableCache: vi.fn(),
    runtimeProcessEnvironment: vi.fn<() => Promise<NodeJS.ProcessEnv>>(() =>
        Promise.resolve(process.env),
    ),
}));

vi.mock('../../executables', () => ({
    resolveRuntimeExecutable: mocks.resolveRuntimeExecutable,
    clearRuntimeExecutableCache: mocks.clearRuntimeExecutableCache,
    runtimeProcessEnvironment: mocks.runtimeProcessEnvironment,
}));

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearExecutableCache, discoverExecutable, readVersion } from '../discovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    // Reset in-flight/version caches before resetting the mocks so this cleanup call itself is
    // never recorded against the next test's assertions on `mocks.clearRuntimeExecutableCache`.
    clearExecutableCache();
    mocks.resolveRuntimeExecutable.mockReset();
    mocks.clearRuntimeExecutableCache.mockReset();
    mocks.runtimeProcessEnvironment.mockReset();
    mocks.runtimeProcessEnvironment.mockResolvedValue(process.env);
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
        mocks.resolveRuntimeExecutable.mockReturnValue(deferred.promise);

        const first = discoverExecutable('codex', '/opt/tools/codex');
        const second = discoverExecutable('codex', '/opt/tools/codex');
        expect(mocks.resolveRuntimeExecutable).toHaveBeenCalledTimes(1);

        deferred.resolve('/resolved/codex');
        await expect(first).resolves.toBe('/resolved/codex');
        await expect(second).resolves.toBe('/resolved/codex');
    });

    it('does not coalesce requests for different requested executables', async () => {
        const deferredA = Promise.withResolvers<string | undefined>();
        const deferredB = Promise.withResolvers<string | undefined>();
        mocks.resolveRuntimeExecutable.mockImplementation((name: string) =>
            name === '/opt/tools/codex-a' ? deferredA.promise : deferredB.promise,
        );

        const first = discoverExecutable('codex', '/opt/tools/codex-a');
        const second = discoverExecutable('codex', '/opt/tools/codex-b');
        expect(mocks.resolveRuntimeExecutable).toHaveBeenCalledTimes(2);

        deferredA.resolve('/resolved/a');
        deferredB.resolve('/resolved/b');
        await expect(first).resolves.toBe('/resolved/a');
        await expect(second).resolves.toBe('/resolved/b');
    });

    it('issues a fresh resolution for each call once the previous one has settled', async () => {
        mocks.resolveRuntimeExecutable.mockResolvedValueOnce('/resolved/first');
        mocks.resolveRuntimeExecutable.mockResolvedValueOnce('/resolved/second');

        await expect(discoverExecutable('codex', '/opt/tools/codex')).resolves.toBe(
            '/resolved/first',
        );
        await expect(discoverExecutable('codex', '/opt/tools/codex')).resolves.toBe(
            '/resolved/second',
        );
        expect(mocks.resolveRuntimeExecutable).toHaveBeenCalledTimes(2);
    });
});

describe('clearExecutableCache', () => {
    it('delegates to the shared runtime executable cache', () => {
        clearExecutableCache();

        expect(mocks.clearRuntimeExecutableCache).toHaveBeenCalledOnce();
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
