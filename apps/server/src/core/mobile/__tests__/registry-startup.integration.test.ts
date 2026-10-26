import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveServerProfilePaths } from '../../profile';
import type { ServerCore } from '../../server-core';
import { startServerCore } from '../../server-core';

const apps: ServerCore[] = [];
const directories: string[] = [];

afterEach(async () => {
    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));
    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('mobile registry startup', () => {
    it('refuses to start with a registry from another version and leaves it untouched', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-mobile-legacy-'));
        directories.push(userDataPath);
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        const legacy = '{"version":1,"devices":[]}\n';
        await writeFile(paths.mobileDevices, legacy, { mode: 0o600 });

        await expect(
            startServerCore({ commit: 'test', userDataPath, version: '1.0.0' }),
        ).rejects.toThrow('pair phones again');
        expect(await readFile(paths.mobileDevices, 'utf8')).toBe(legacy);

        await rm(paths.mobileDevices);
        const app = await startServerCore({ commit: 'test', userDataPath, version: '1.0.0' });
        apps.push(app);
        expect(app.lease.identity.profileId).toBe(paths.profileId);
    });

    it('releases the profile lease when the private registry fails to open', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-mobile-registry-'));
        directories.push(userDataPath);
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        await writeFile(paths.mobileDevices, '{"version":2,"devices":[]}\n', { mode: 0o644 });

        await expect(
            startServerCore({ commit: 'test', userDataPath, version: '1.0.0' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });

        await chmod(paths.mobileDevices, 0o600);
        const app = await startServerCore({ commit: 'test', userDataPath, version: '1.0.0' });
        apps.push(app);
        expect(app.lease.identity.profileId).toBe(paths.profileId);
    });
});
