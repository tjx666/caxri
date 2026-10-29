import { describe, expect, it } from 'vitest';

import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import { MobileDeviceRegistry } from '../device-registry';

function registryFixture() {
    let byte = 1;
    return {
        store: createMemoryMobileDeviceStore(),
        now: () => 1_788_106_000_000 + byte,
        random: (bytes: number) => new Uint8Array(bytes).fill(byte++),
    };
}

describe('MobileDeviceRegistry', () => {
    it('starts empty and persists a credential without exposing it in summaries', async () => {
        const options = registryFixture();
        const registry = MobileDeviceRegistry.open(options);
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
        expect(options.store.devices.map((device) => device.credential)).toEqual([
            paired.credential,
        ]);

        const reopened = MobileDeviceRegistry.open(options);
        expect(reopened.list()).toEqual([paired.device]);
        expect(reopened.currentPrincipal(paired.device.deviceId, 1)).toMatchObject({
            role: 'control',
            projectIds: ['project-1'],
        });

        await reopened.rememberPort(43_341);
        const withEndpoint = MobileDeviceRegistry.open(options);
        expect(withEndpoint.preferredPort()).toBe(43_341);
    });

    it('authenticates the exact credential and invalidates both live and stored generations on revoke', async () => {
        const options = registryFixture();
        const registry = MobileDeviceRegistry.open(options);
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

        const reopened = MobileDeviceRegistry.open(options);
        expect(() =>
            reopened.authenticate({
                credential: paired.credential,
                deviceId: paired.device.deviceId,
                generation: 1,
            }),
        ).toThrow('Paired device authorization is unavailable');
    });

    it('fails closed when the stored devices are malformed or duplicated', () => {
        const row = {
            deviceId: `device_${'aa'.repeat(16)}`,
            displayName: 'Old phone',
            platform: 'ios',
            credential: 'bb'.repeat(32),
            generation: 1,
            role: 'control',
            projectIds: ['project-1'],
            createdAt: 1,
        };
        expect(() =>
            MobileDeviceRegistry.open({
                store: createMemoryMobileDeviceStore({ devices: [{ ...row, generation: 0 }] }),
            }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(() =>
            MobileDeviceRegistry.open({
                store: createMemoryMobileDeviceStore({ devices: [row, row] }),
            }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });

    it('leaves the registry unchanged when the write fails', async () => {
        const options = registryFixture();
        const registry = MobileDeviceRegistry.open(options);
        options.store.failNextWrite();
        await expect(
            registry.pair({
                displayName: 'Pixel 8',
                platform: 'android',
                projectIds: ['project-1'],
            }),
        ).rejects.toThrow('injected write failure');
        expect(registry.list()).toEqual([]);
        expect(options.store.devices).toEqual([]);
        await registry.pair({
            displayName: 'Pixel 8',
            platform: 'android',
            projectIds: ['project-1'],
        });
        expect(registry.list()).toHaveLength(1);
    });

    it('rejects a pair once the registry holds 128 active devices', async () => {
        const devices = Array.from({ length: 128 }, (_, index) => ({
            deviceId: `device_${index.toString(16).padStart(32, '0')}`,
            displayName: `Device ${index}`,
            platform: 'android',
            credential: 'cc'.repeat(32),
            generation: 1,
            role: 'control',
            projectIds: ['project-1'],
            createdAt: 1,
        }));
        const registry = MobileDeviceRegistry.open({
            store: createMemoryMobileDeviceStore({ devices }),
        });
        await expect(
            registry.pair({
                displayName: 'One too many',
                platform: 'android',
                projectIds: ['project-1'],
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        expect(registry.list()).toHaveLength(128);
    });

    it('keeps one Relay host key across restarts and reports device changes', async () => {
        const options = registryFixture();
        const registry = MobileDeviceRegistry.open(options);
        const changes: number[] = [];
        const stop = registry.onDevicesChanged(() =>
            changes.push(registry.activeCredentials().length),
        );
        const [first, concurrent] = await Promise.all([
            registry.relayHostKey(),
            registry.relayHostKey(),
        ]);
        expect(first).toMatch(/^[0-9a-f]{64}$/u);
        expect(concurrent).toBe(first);
        const paired = await registry.pair({
            displayName: 'Relay phone',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.revoke(paired.device.deviceId, paired.device.generation);
        stop();
        expect(changes).toEqual([1, 0]);
        expect(registry.activeCredentials()).toEqual([]);

        const reopened = MobileDeviceRegistry.open(options);
        await expect(reopened.relayHostKey()).resolves.toBe(first);
    });
});
