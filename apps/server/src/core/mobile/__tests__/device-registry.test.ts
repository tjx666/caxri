import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MobileDeviceRegistry } from '../device-registry';

const temporaryDirectories: string[] = [];

async function registryFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-devices-'));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let byte = 1;
    return {
        directory,
        path: join(directory, 'mobile-devices.json'),
        now: () => 1_788_106_000_000 + byte,
        random: (bytes: number) => new Uint8Array(bytes).fill(byte++),
    };
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileDeviceRegistry', () => {
    it('starts empty and atomically persists a private credential without exposing it in summaries', async () => {
        const options = await registryFixture();
        const registry = await MobileDeviceRegistry.open(options);
        expect(registry.list()).toEqual([]);

        const paired = await registry.pair({
            displayName: 'Pixel 8',
            platform: 'android',
            projectIds: ['project-1'],
        });
        expect(paired.device).toMatchObject({
            deviceId: `device_${'01'.repeat(16)}`,
            displayName: 'Pixel 8',
            generation: 1,
            role: 'control',
        });
        expect(paired).not.toHaveProperty('device.credential');
        expect((await stat(options.path)).mode & 0o777).toBe(0o600);
        expect(await readFile(options.path, 'utf8')).toContain(paired.credential);
        expect((await readdir(options.directory)).filter((name) => name.endsWith('.tmp'))).toEqual(
            [],
        );

        const reopened = await MobileDeviceRegistry.open(options);
        expect(reopened.list()).toEqual([paired.device]);
        expect(reopened.currentPrincipal(paired.device.deviceId, 1)).toMatchObject({
            role: 'control',
            projectIds: ['project-1'],
        });

        await reopened.rememberPort(43_341);
        const withEndpoint = await MobileDeviceRegistry.open(options);
        expect(withEndpoint.preferredPort()).toBe(43_341);
    });

    it('fails closed with a recovery step for a store written by another version', async () => {
        const options = await registryFixture();
        const legacy = `${JSON.stringify({
            version: 1,
            devices: [
                {
                    deviceId: `device_${'aa'.repeat(16)}`,
                    displayName: 'Old phone',
                    platform: 'ios',
                    credential: 'bb'.repeat(32),
                    generation: 1,
                    projectIds: ['project-1'],
                    createdAt: 1,
                },
            ],
        })}\n`;
        await writeFile(options.path, legacy, { mode: 0o600 });
        await expect(MobileDeviceRegistry.open(options)).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        await expect(MobileDeviceRegistry.open(options)).rejects.toThrow('pair phones again');
        expect(await readFile(options.path, 'utf8')).toBe(legacy);
    });

    it('authenticates the exact credential and invalidates both live and stored generations on revoke', async () => {
        const options = await registryFixture();
        const registry = await MobileDeviceRegistry.open(options);
        const paired = await registry.pair({
            displayName: 'Android tablet',
            platform: 'android',
            projectIds: ['project-1', 'project-2'],
        });
        expect(
            registry.authenticate({
                credential: paired.credential,
                deviceId: paired.device.deviceId,
                generation: 1,
            }),
        ).toMatchObject({
            kind: 'paired-device',
            generation: 1,
            projectIds: ['project-1', 'project-2'],
        });
        expect(() =>
            registry.authenticate({
                credential: 'ff'.repeat(32),
                deviceId: paired.device.deviceId,
                generation: 1,
            }),
        ).toThrow('Paired device authorization is unavailable');

        const revoked = await registry.revoke(paired.device.deviceId, paired.device.generation);
        expect(revoked.generation).toBe(2);
        expect(typeof revoked.revokedAt).toBe('number');
        expect(() => registry.currentPrincipal(paired.device.deviceId, 1)).toThrow(
            'Paired device authorization is unavailable',
        );
        await expect(
            registry.revoke(paired.device.deviceId, paired.device.generation),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        const reopened = await MobileDeviceRegistry.open(options);
        expect(() =>
            reopened.authenticate({
                credential: paired.credential,
                deviceId: paired.device.deviceId,
                generation: 1,
            }),
        ).toThrow('Paired device authorization is unavailable');
    });

    it('fails closed when an existing registry is not private', async () => {
        const options = await registryFixture();
        await writeFile(options.path, '{"version":2,"devices":[]}\n', { mode: 0o644 });
        await expect(MobileDeviceRegistry.open(options)).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });

    it('rejects a pair before a valid store can exceed its restart read limit', async () => {
        const options = await registryFixture();
        const registry = await MobileDeviceRegistry.open(options);
        const projectIds = Array.from({ length: 128 }, (_, index) =>
            `project-${index}-${'x'.repeat(200)}`.slice(0, 200),
        );
        let successfulPairs = 0;
        for (let index = 0; index < 10; index += 1) {
            try {
                // eslint-disable-next-line no-await-in-loop -- the serialized store limit is the behavior under test.
                await registry.pair({
                    displayName: `Device ${index}`,
                    platform: 'android',
                    projectIds,
                });
                successfulPairs += 1;
            } catch (error) {
                expect(error).toMatchObject({ code: 'CAPACITY' });
                break;
            }
        }
        expect(successfulPairs).toBeGreaterThan(0);
        expect(successfulPairs).toBeLessThan(10);
        const reopened = await MobileDeviceRegistry.open(options);
        expect(reopened.list()).toHaveLength(successfulPairs);
    });
});
