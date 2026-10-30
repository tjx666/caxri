import type { MobileServerPayload } from '@caxri/mobile-transport';
import type { CommandExecutionContext, Principal } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, createCommandDispatcher } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileGatewayFrameRouter } from '../frame-router';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('MobileGatewayFrameRouter heartbeat', () => {
    it('acknowledges a foreground probe and closes an idle authenticated socket', async () => {
        vi.useFakeTimers();
        const send = vi.fn<(payload: MobileServerPayload) => Promise<void>>(() =>
            Promise.resolve(),
        );
        const terminate = vi.fn();
        const app = new MobileGatewayFrameRouter({
            authorizeMethod: () => {},
            authorizeSubscription: () => Promise.resolve(),
            context: () => ({
                capabilities: [],
                principal,
                connection: {
                    serverId: 'a'.repeat(32),
                    bootId: 'b'.repeat(32),
                    stateEpoch: 'c'.repeat(32),
                    clientId: 'mobile:device-1',
                    connectionId: 'd'.repeat(32),
                },
            }),
            dispatch: createCommandDispatcher({
                server: {
                    invoke: () => {
                        throw new Error('Unexpected command');
                    },
                },
            }),
            isActive: () => true,
            matchesSubscriptionEvent: () => Promise.resolve(true),
            now: () => Date.now(),
            randomSubscriptionId: () => 'subscription-1',
            send,
            terminate,
        });
        try {
            vi.advanceTimersByTime(9_000);
            app.accept({ type: 'heartbeat', nonce: 'ab'.repeat(16) });
            await Promise.resolve();
            expect(send).toHaveBeenCalledWith({
                type: 'heartbeat-ack',
                nonce: 'ab'.repeat(16),
            });
            vi.advanceTimersByTime(9_000);
            expect(terminate).not.toHaveBeenCalled();
            vi.advanceTimersByTime(3_000);
            expect(terminate).toHaveBeenCalledOnce();
        } finally {
            app.close();
        }
    });
});

describe('MobileGatewayFrameRouter E2E acknowledgement loss', () => {
    it('closes only the first successful Agent submit before sending a reply', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE', '1');
        const send = vi.fn<(payload: MobileServerPayload) => Promise<void>>(() =>
            Promise.resolve(),
        );
        const terminate = vi.fn();
        const app = new MobileGatewayFrameRouter({
            authorizeMethod: () => {},
            authorizeSubscription: () => Promise.resolve(),
            context: () => ({
                capabilities: ['terminals.steer'],
                principal: { ...principal, role: 'reply' },
                connection: {
                    serverId: 'a'.repeat(32),
                    bootId: 'b'.repeat(32),
                    stateEpoch: 'c'.repeat(32),
                    clientId: 'mobile:device-1',
                    connectionId: 'd'.repeat(32),
                },
            }),
            dispatch: createCommandDispatcher({
                server: { invoke: () => ({ terminalId: 'terminal-1', outcome: 'accepted' }) },
            }),
            isActive: () => true,
            matchesSubscriptionEvent: () => Promise.resolve(true),
            now: () => Date.now(),
            randomSubscriptionId: () => 'subscription-1',
            send,
            terminate,
        });
        const request = (id: string) => ({
            type: 'request' as const,
            request: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method: 'mobile.agent.submit',
                params: {
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                    endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                    clientMutationId: id,
                    text: 'continue',
                },
            },
        });
        try {
            app.accept(request('first'));
            await vi.waitFor(() =>
                expect(terminate.mock.calls.length + send.mock.calls.length).toBeGreaterThan(0),
            );
            expect(send).not.toHaveBeenCalled();
            expect(terminate).toHaveBeenCalledOnce();
            app.accept(request('second'));
            await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
            expect(send.mock.calls[0]?.[0]).toMatchObject({
                type: 'reply',
                reply: { id: 'second', ok: true },
            });
        } finally {
            app.close();
        }
    });
});

describe('MobileGatewayFrameRouter request timing', () => {
    it('reports how long an authorized request took to dispatch', async () => {
        let now = 1_000;
        const send = vi.fn<(payload: MobileServerPayload) => Promise<void>>(() =>
            Promise.resolve(),
        );
        const reportRequest = vi.fn<(method: string, durationMs: number) => void>();
        const dispatcher = createCommandDispatcher({
            server: { invoke: () => ({ terminalId: 'terminal-1', outcome: 'accepted' }) },
        });
        const app = new MobileGatewayFrameRouter({
            authorizeMethod: () => {},
            authorizeSubscription: () => Promise.resolve(),
            context: () => ({
                capabilities: [],
                principal,
                connection: {
                    serverId: 'a'.repeat(32),
                    bootId: 'b'.repeat(32),
                    stateEpoch: 'c'.repeat(32),
                    clientId: 'mobile:device-1',
                    connectionId: 'd'.repeat(32),
                },
            }),
            dispatch: Object.assign(
                async (envelope: unknown, context: CommandExecutionContext) => {
                    const reply = await dispatcher(envelope, context);
                    now += 180;
                    return reply;
                },
                {
                    admit: (envelope: unknown, context: CommandExecutionContext) =>
                        dispatcher.admit(envelope, context),
                },
            ),
            isActive: () => true,
            matchesSubscriptionEvent: () => Promise.resolve(true),
            now: () => now,
            randomSubscriptionId: () => 'subscription-1',
            reportRequest,
            send,
            terminate: vi.fn(),
        });
        try {
            app.accept({
                type: 'request',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'request-1',
                    method: 'mobile.agent.submit',
                    params: {
                        sessionId: 'session-1',
                        terminalId: 'terminal-1',
                        endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                        clientMutationId: 'request-1',
                        text: 'continue',
                    },
                },
            });
            await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
            expect(reportRequest).toHaveBeenCalledExactlyOnceWith('mobile.agent.submit', 180);
        } finally {
            app.close();
        }
    });
});
