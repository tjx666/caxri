import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireHostProfile, readHostManifest, resolveHostProfilePaths } from '../profile';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

async function listen(path: string): Promise<Server> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
    });
    return server;
}

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                }),
        ),
    );
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Host profile lease', () => {
    it('writes a private atomic manifest only after the UDS is listening', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-profile-');
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const lease = await acquireHostProfile({
            socketDirectory,
            userDataPath,
            version: '1.2.3',
        });
        await expect(readFile(lease.paths.manifest, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await listen(lease.paths.endpoint);
        await lease.publish();

        expect(await readHostManifest(lease.paths.manifest)).toEqual(lease.manifest);
        expect((await stat(lease.paths.manifest)).mode & 0o777).toBe(0o600);
        expect((await stat(lease.paths.lock)).mode & 0o777).toBe(0o600);
        expect((await stat(lease.paths.endpoint)).mode & 0o777).toBe(0o600);
        await lease.release();
        await expect(readFile(lease.paths.manifest, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('admits only one owner before any Runtime can start', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-single-');
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const first = await acquireHostProfile({ socketDirectory, userDataPath, version: '1.0.0' });
        await expect(
            acquireHostProfile({ socketDirectory, userDataPath, version: '1.0.0' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await first.release();
    });

    it('keeps a deeply nested profile on a short deterministic socket path', async () => {
        const root = await temporaryDirectory('caxri-host-deep-');
        const userDataPath = join(root, 'a'.repeat(80), 'b'.repeat(80), 'profile');
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const paths = await resolveHostProfilePaths(userDataPath, socketDirectory);
        expect(Buffer.byteLength(paths.endpoint, 'utf8')).toBeLessThanOrEqual(103);
        expect(paths.endpoint.startsWith(socketDirectory)).toBe(true);
    });

    it('reclaims metadata only after the previous process is proven dead', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-stale-');
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const paths = await resolveHostProfilePaths(userDataPath, socketDirectory);
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
        const recovered = await acquireHostProfile({
            processState: () => 'dead',
            socketDirectory,
            userDataPath,
            version: '1.0.0',
        });
        expect(recovered.manifest.processIdentity).not.toBe('1'.repeat(32));
        expect(await readFile(recovered.paths.lock, 'utf8')).toContain(
            recovered.manifest.processIdentity,
        );
        await recovered.release();
    });

    it('admits one owner during concurrent stale takeover', async () => {
        const userDataPath = await temporaryDirectory('caxri-host-stale-race-');
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const paths = await resolveHostProfilePaths(userDataPath, socketDirectory);
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
                acquireHostProfile({
                    processState: () => 'dead',
                    socketDirectory,
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
        const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
        const stale = await acquireHostProfile({ socketDirectory, userDataPath, version: '1.0.0' });
        await writeFile(stale.paths.manifest, '{not-json}\n', { mode: 0o600 });
        await stale.release();
        await expect(
            acquireHostProfile({
                processState: () => 'dead',
                socketDirectory,
                userDataPath,
                version: '1.0.0',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
});
