import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandAdapter, Principal } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { connectDevice } from './gateway-client.fixture';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

const dashboard = {
    hostDisplayName: 'Test computer',
    deviceRole: 'control',
    projects: [],
    sessions: [],
    total: 0,
    truncated: false,
};

describe('MobileGateway Project grants', () => {
    it('keeps the connection and adopts a Project granted mid-connection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gateway-grant-'));
        temporaryDirectories.push(directory);
        let byte = 1;
        const registry = await MobileDeviceRegistry.open({
            directory,
            path: join(directory, 'mobile-devices.json'),
            now: () => 1_788_106_000_000 + byte,
            random: (bytes) => new Uint8Array(bytes).fill(byte++),
        });
        const record = registry.preparePair({
            displayName: 'Test phone',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const seenProjects: string[][] = [];
        const invoke = vi.fn<CommandAdapter['invoke']>(async (_request, context) => {
            if (context.principal.kind === 'paired-device') {
                seenProjects.push([...context.principal.projectIds]);
                if (seenProjects.length === 1)
                    await registry.grantProject(
                        context.principal.deviceId,
                        context.principal.generation,
                        'project-2',
                    );
            }
            return dashboard;
        });
        const gateway = new MobileGateway({
            adapters: { server: { invoke } },
            authorizePairedDeviceMethod: (principal: Principal, method: string) => {
                if (
                    principal.kind !== 'paired-device' ||
                    !isMobileGatewayMethodAllowedForRole(principal.role, method)
                )
                    throw new CaxriError(
                        'FORBIDDEN',
                        'Paired device role does not allow this method',
                    );
            },
            authorizeSubscription: () => Promise.resolve(),
            matchesSubscriptionEvent: () => Promise.resolve(true),
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const client = await connectDevice(gateway, record);
        const request = (id: string) => ({
            type: 'request',
            request: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method: 'mobile.dashboard',
                params: {},
            },
        });
        try {
            for (const id of ['grant', 'after']) {
                const reply = client.read();
                client.send(request(id));
                // eslint-disable-next-line no-await-in-loop -- The second request must follow the grant.
                await expect(reply).resolves.toMatchObject({
                    type: 'reply',
                    reply: { id, ok: true },
                });
            }
            expect(seenProjects).toEqual([['project-1'], ['project-1', 'project-2']]);
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });
});
