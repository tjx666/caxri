import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveServerProfilePaths } from '../../profile';
import type { ServerCore } from '../../server-core';
import { startServerCore } from '../../server-core';
import { MobileDeviceRegistry } from '../device-registry';

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
    it('starts Server Core with a valid pre-role registry while fencing its old credential', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-mobile-legacy-'));
        directories.push(userDataPath);
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        const deviceId = `device_${'aa'.repeat(16)}`;
        const credential = 'bb'.repeat(32);
        await writeFile(
            paths.mobileDevices,
            `${JSON.stringify({
                version: 1,
                devices: [
                    {
                        deviceId,
                        displayName: 'Old phone',
                        platform: 'ios',
                        credential,
                        generation: 1,
                        projectIds: ['project-1'],
                        createdAt: 1,
                    },
                ],
            })}\n`,
            { mode: 0o600 },
        );

        const app = await startServerCore({ commit: 'test', userDataPath, version: '1.0.0' });
        apps.push(app);
        const registry = await MobileDeviceRegistry.open({
            directory: paths.directory,
            path: paths.mobileDevices,
        });
        expect(registry.list()).toEqual([]);
        expect(() => registry.authenticate({ credential, deviceId, generation: 1 })).toThrow(
            'Paired device authorization is unavailable',
        );
    });

    it('releases the profile lease when the private registry fails to open', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-mobile-registry-'));
        directories.push(userDataPath);
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        await writeFile(paths.mobileDevices, '{"version":1,"devices":[]}\n', { mode: 0o644 });

        await expect(
            startServerCore({ commit: 'test', userDataPath, version: '1.0.0' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });

        await chmod(paths.mobileDevices, 0o600);
        const app = await startServerCore({ commit: 'test', userDataPath, version: '1.0.0' });
        apps.push(app);
        expect(app.lease.identity.profileId).toBe(paths.profileId);
    });
});
