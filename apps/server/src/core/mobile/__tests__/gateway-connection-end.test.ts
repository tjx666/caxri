import { mobileClientCloseReasons } from '@caxri/mobile-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileGateway } from '../gateway';
import {
    authorizeMethod,
    connectDevice,
    registryFixture,
    subscriptionOptions,
} from './gateway-client.fixture';

/**
 * Every `mobile_gateway.connection_ended` carries who ended the connection (issue caxri#2746), so a phone that went to
 * the background reads differently from one that hit an error or lost its network.
 */
const setup = async () => {
    const registry = registryFixture();
    const record = registry.preparePair({
        displayName: 'Test tablet',
        platform: 'android',
        projectIds: ['project-1'],
    });
    await registry.commitPair(record);
    const write = vi.fn();
    const clock = { now: 1_000 };
    const gateway = new MobileGateway({
        ...subscriptionOptions,
        adapters: { server: { invoke: vi.fn() } },
        authorizePairedDeviceMethod: authorizeMethod,
        bootId: 'b'.repeat(32),
        protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        registry,
        logger: { write },
        selectAddress: () => '127.0.0.1',
        now: () => clock.now,
    });
    const ended = async (): Promise<Record<string, unknown>> => {
        let fields: Record<string, unknown> | undefined;
        await vi.waitFor(() => {
            const call = write.mock.calls.find(
                ([, event]) => event === 'mobile_gateway.connection_ended',
            );
            expect(call).toBeDefined();
            fields = (call![2] as { fields: Record<string, unknown> }).fields;
        });
        return fields!;
    };
    return { clock, ended, gateway, record, registry, write };
};

describe('MobileGateway connection end cause', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('decodes the phone close code into its own reason', async () => {
        const { ended, gateway, record } = await setup();
        try {
            const client = await connectDevice(gateway, record);
            client.socket.close(mobileClientCloseReasons.unmounted, 'unmounted');
            expect(await ended()).toEqual({
                deviceId: record.deviceId,
                durationMs: 0,
                cause: 'peer-closed',
                closeCode: 4_010,
                clientReason: 'unmounted',
            });
        } finally {
            await gateway.close();
        }
    });

    it('reads a socket that ended without a close frame as a dropped peer', async () => {
        const { ended, gateway, record } = await setup();
        try {
            const client = await connectDevice(gateway, record);
            client.socket.terminate();
            expect(await ended()).toEqual({
                deviceId: record.deviceId,
                durationMs: 0,
                cause: 'peer-dropped',
            });
        } finally {
            await gateway.close();
        }
    });

    it('records a silent phone as heartbeat-idle without a failure warning', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const { clock, ended, gateway, record, write } = await setup();
        try {
            await connectDevice(gateway, record);
            clock.now += 13_000;
            vi.advanceTimersByTime(3_000);
            expect(await ended()).toEqual({
                deviceId: record.deviceId,
                durationMs: 13_000,
                cause: 'heartbeat-idle',
            });
            expect(write).not.toHaveBeenCalledWith(
                'warn',
                'mobile_gateway.failure',
                expect.anything(),
            );
        } finally {
            await gateway.close();
        }
        const summary = write.mock.calls.findLast(
            ([, event]) => event === 'mobile_gateway.failure_summary',
        );
        expect(summary?.[2]).toMatchObject({ fields: { heartbeatIdle: 1, total: 1 } });
    });

    it('records connections cut off by revocation and by disabling the gateway', async () => {
        const revokedSetup = await setup();
        try {
            await connectDevice(revokedSetup.gateway, revokedSetup.record);
            await revokedSetup.gateway.revoke(
                revokedSetup.record.deviceId,
                revokedSetup.record.generation,
            );
            expect(await revokedSetup.ended()).toMatchObject({ cause: 'revoked' });
        } finally {
            await revokedSetup.gateway.close();
        }

        const disabledSetup = await setup();
        await connectDevice(disabledSetup.gateway, disabledSetup.record);
        await disabledSetup.gateway.close();
        expect(await disabledSetup.ended()).toMatchObject({ cause: 'gateway-disabled' });
    });
});
