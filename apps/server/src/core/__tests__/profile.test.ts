import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireServerProfile, readServerManifest, resolveServerProfilePaths } from '../profile';

const temporaryDirectories: string[] = [];
const endpoint = { protocol: 'ws', host: '127.0.0.1', port: 41_337, path: '/control' } as const;

async function temporaryDirectory(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Host profile lease', () => {
    it('writes a private atomic manifest only after the loopback endpoint is listening', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-profile-');
        const lease = await acquireServerProfile({ userDataPath, version: '1.2.3' });
        await expect(readFile(lease.paths.manifest, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        const manifest = await lease.publish(endpoint);

        expect(await readServerManifest(lease.paths.manifest)).toEqual(manifest);
        expect((await stat(lease.paths.manifest)).mode & 0o777).toBe(0o600);
        expect((await stat(lease.paths.lock)).mode & 0o777).toBe(0o600);
        expect((await readdir(lease.paths.directory)).some((name) => name.endsWith('.sock'))).toBe(
            false,
        );
        await lease.release();
        await expect(readFile(lease.paths.manifest, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('refuses to publish a manifest once a stop during startup released the lease', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-released-');
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        await lease.release();

        await expect(lease.publish(endpoint)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(readFile(lease.paths.manifest, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('admits only one owner before any Runtime can start', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-single-');
        const first = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        await expect(
            acquireServerProfile({ userDataPath, version: '1.0.0' }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await first.release();
    });

    it('keeps discovery metadata inside a deeply nested profile', async () => {
        const root = await temporaryDirectory('caxri-host-deep-');
        const userDataPath = join(root, 'a'.repeat(80), 'b'.repeat(80), 'profile');
        const paths = await resolveServerProfilePaths(userDataPath);
        expect(paths.manifest).toBe(join(paths.directory, 'manifest.json'));
        expect(paths.directory).toBe(join(paths.userDataPath, 'host'));
    });

    it('reclaims metadata only after the previous process is proven dead', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-stale-');
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        await writeFile(
            paths.lock,
            `${JSON.stringify({
                pid: 999_999,
                startedAt: 1,
                processIdentity: '1'.repeat(32),
                profileId: paths.profileId,
            })}\n`,
            { mode: 0o600 },
        );
        const recovered = await acquireServerProfile({
            processState: () => 'dead',
            userDataPath,
            version: '1.0.0',
        });
        expect(recovered.identity.processIdentity).not.toBe('1'.repeat(32));
        expect(await readFile(recovered.paths.lock, 'utf8')).toContain(
            recovered.identity.processIdentity,
        );
        await recovered.release();
    });

    it('admits one owner during concurrent stale takeover', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-stale-race-');
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        await writeFile(
            paths.lock,
            `${JSON.stringify({
                pid: 999_999,
                startedAt: 1,
                processIdentity: '2'.repeat(32),
                profileId: paths.profileId,
            })}\n`,
            { mode: 0o600 },
        );
        const contenders = await Promise.allSettled(
            Array.from({ length: 16 }, () =>
                acquireServerProfile({
                    processState: () => 'dead',
                    userDataPath,
                    version: '1.0.0',
                }),
            ),
        );
        const winners = contenders.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
        );
        expect(winners).toHaveLength(1);
        for (const result of contenders)
            if (result.status === 'rejected')
                expect(result.reason).toMatchObject({ code: 'CONFLICT' });
        await winners[0].release();
    });

    it('fails closed on a corrupt stale manifest with a stable repair error', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-corrupt-');
        const stale = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        await stale.publish(endpoint);
        await writeFile(stale.paths.manifest, '{not-json}\n', { mode: 0o600 });
        await stale.release();
        await expect(
            acquireServerProfile({
                processState: () => 'dead',
                userDataPath,
                version: '1.0.0',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
});
