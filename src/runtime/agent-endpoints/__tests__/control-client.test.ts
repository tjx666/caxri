import { describe, expect, it, vi } from 'vitest';

import type { RuntimeParentPort } from '../../port';
import { RuntimeAgentEndpointControlClient } from '../control-client';

function port() {
    const send = vi.fn();
    return {
        send,
        value: {
            connected: () => true,
            onMessage: () => undefined,
            send,
        } satisfies RuntimeParentPort,
    };
}

describe('RuntimeAgentEndpointControlClient', () => {
    it('correlates a validated begin reply on the private parent channel', async () => {
        const parent = port();
        const client = new RuntimeAgentEndpointControlClient(parent.value);
        const result = client.begin({
            terminalId: 'terminal-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            provider: 'codex',
            launchId: 'launch-1',
            name: 'Codex',
            permissionClass: 'standard',
            messaging: {
                deliveryMode: 'unavailable',
                health: 'unsupported',
                reason: 'adapter_unavailable',
                checkedAt: 1,
                nextAction: 'restart_terminal',
            },
        });
        const request = parent.send.mock.calls[0]?.[0] as { id: string };

        expect(
            client.handleMessage({
                type: 'host-control.reply',
                id: request.id,
                ok: true,
                result: {
                    ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                    token: 'ab'.repeat(32),
                    expiresAt: 10_000,
                },
            }),
        ).toBe(true);
        await expect(result).resolves.toMatchObject({
            ref: { endpointId: 'endpoint-1', generation: 1 },
        });
    });

    it('correlates activation for the exact prepared Endpoint generation', async () => {
        const parent = port();
        const client = new RuntimeAgentEndpointControlClient(parent.value);
        const result = client.activate({
            ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            launchId: 'launch-1',
        });
        const request = parent.send.mock.calls[0]?.[0] as {
            id: string;
            operation: string;
        };

        expect(request.operation).toBe('agent-endpoint.activate');
        expect(
            client.handleMessage({
                type: 'host-control.reply',
                id: request.id,
                ok: true,
                result: { activated: true },
            }),
        ).toBe(true);
        await expect(result).resolves.toBe(true);
    });

    it('keeps ordinary Runtime messages outside the control reply path', () => {
        const parent = port();
        const client = new RuntimeAgentEndpointControlClient(parent.value);

        expect(
            client.handleMessage({
                event: 'runtime.status',
                payload: { status: 'ready', restartCount: 0 },
            }),
        ).toBe(false);
    });
});
