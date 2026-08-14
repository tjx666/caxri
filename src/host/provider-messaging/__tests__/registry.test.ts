import { describe, expect, it, vi } from 'vitest';

import type { AgentEndpointBeginParams } from '../../../shared/ipc/agent-endpoint-control';
import type { ProviderMessageAck } from '../../../shared/ipc/provider-messaging-contract';
import { AgentEndpointRegistry } from '../../agent-endpoints';
import { ProviderMessagingAdapterRegistry } from '..';

const TOKEN = 'ab'.repeat(32);

function setup() {
    const endpoints = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
    const params = {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        provider: 'claude',
        launchId: 'launch-1',
        name: 'Claude Code',
        permissionClass: 'standard',
        messaging: {
            deliveryMode: 'push',
            health: 'ready',
            reason: 'provider_channel_ready',
            checkedAt: 1,
            nextAction: 'none',
            providerVersion: '2.1.231',
        },
    } satisfies AgentEndpointBeginParams;
    const endpoint = endpoints.begin(params);
    if (!endpoints.activate({ ref: endpoint.ref, launchId: params.launchId }))
        throw new Error('Agent Endpoint activation failed in test setup');
    const summary = endpoints.resolve(endpoint.ref);
    const registry = new ProviderMessagingAdapterRegistry(endpoints);
    return { endpoint, endpoints, params, registry, summary };
}

function inbound(to: ReturnType<typeof setup>['endpoint']['ref']) {
    return {
        id: 'message-1',
        origin: 'peer' as const,
        from: {
            ...setup().summary,
            ref: { hostId: 'host-1', endpointId: 'sender-1', generation: 1 },
            terminalId: 'terminal-sender',
        },
        to,
        body: 'plain peer text',
        createdAt: 1,
        expiresAt: 10_000,
    };
}

describe('ProviderMessagingAdapterRegistry', () => {
    it('reports success only after the exact fake push adapter ack', async () => {
        const { registry, summary } = setup();
        let acknowledge!: (ack: ProviderMessageAck) => void;
        const deliver = vi.fn(
            (delivery: { deliveryId: string }) =>
                new Promise<ProviderMessageAck>((resolve) => {
                    acknowledge = resolve;
                    expect(delivery).toMatchObject({ message: { origin: 'peer' } });
                }),
        );
        registry.register(
            { endpoint: summary, adapterId: 'fake-channel', adapterVersion: '1.0.0' },
            { deliver, revoke: vi.fn() },
        );

        const pending = registry.deliver(inbound(summary.ref));
        await Promise.resolve();
        let settled = false;
        void pending.finally(() => {
            settled = true;
        });
        expect(settled).toBe(false);
        const deliveryId = deliver.mock.calls[0]?.[0].deliveryId;
        acknowledge({ deliveryId, outcome: 'accepted' });
        await expect(pending).resolves.toBeUndefined();
    });

    it('fails closed on ack failure and revokes authority on downgrade or restart', async () => {
        const { endpoint, endpoints, params, registry, summary } = setup();
        const revoke = vi.fn();
        registry.register(
            { endpoint: summary, adapterId: 'fake-channel', adapterVersion: '1.0.0' },
            {
                deliver: ({ deliveryId }) =>
                    Promise.resolve({ deliveryId, outcome: 'retry' as const }),
                revoke,
            },
        );
        await expect(registry.deliver(inbound(summary.ref))).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });

        endpoints.updateMessaging({
            ref: endpoint.ref,
            launchId: 'launch-1',
            messaging: {
                deliveryMode: 'pull',
                health: 'ready',
                reason: 'pull_ready',
                checkedAt: 2,
                nextAction: 'use_pull',
            },
        });
        await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
        endpoints.begin({ ...params, launchId: 'launch-2' });
        await expect(registry.deliver(inbound(summary.ref))).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
    });
});
