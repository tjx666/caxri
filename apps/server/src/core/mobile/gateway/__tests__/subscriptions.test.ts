import type { MobileServerPayload } from '@caxri/mobile-transport';
import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

describe('MobileGatewaySubscriptions', () => {
    it('delivers a normal 256 KiB Terminal batch without a capacity resync', async () => {
        const sent: MobileServerPayload[] = [];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => 'subscription-terminal',
            send: (payload) => {
                sent.push(payload);
                return Promise.resolve();
            },
            terminate: vi.fn(),
        });
        await subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' });
        subscriptions.publish({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'x'.repeat(256 * 1_024) },
        });
        await vi.waitFor(() =>
            expect(sent.filter((payload) => payload.type === 'stream')).toHaveLength(11),
        );
        expect(sent.some((payload) => payload.type === 'event')).toBe(false);
        subscriptions.close();
    });

    it('limits subscriptions whose authorization resolves concurrently', async () => {
        const releaseAuthorization = Promise.withResolvers<void>();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => releaseAuthorization.promise,
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => `subscription-${++nextId}`,
            send: () => Promise.resolve(),
            terminate: vi.fn(),
        });
        const attempts = Array.from({ length: 33 }, () =>
            subscriptions.subscribe({ kind: 'dashboard' }),
        );
        releaseAuthorization.resolve();
        const results = await Promise.allSettled(attempts);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        subscriptions.close();
    });

    it('caps one socket across duplicate Terminal subscriptions without blocking another subscription', async () => {
        const releaseSlowSend = Promise.withResolvers<void>();
        const sent: MobileServerPayload[] = [];
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
                if (payload.type === 'stream') await releaseSlowSend.promise;
            },
            terminate: vi.fn(),
        });
        const terminalIds = await Promise.all(
            Array.from({ length: 5 }, () =>
                subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' }),
            ),
        );
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        try {
            subscriptions.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'x'.repeat(256 * 1_024) },
            });
            subscriptions.publish({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            });
            await vi.waitFor(() =>
                expect(sent).toContainEqual({
                    type: 'event',
                    subscriptionId: terminalIds[4],
                    sequence: 0,
                    kind: 'resync-required',
                    reason: 'capacity',
                }),
            );
            await vi.waitFor(() =>
                expect(sent).toContainEqual({
                    type: 'event',
                    subscriptionId: dashboardId,
                    sequence: 0,
                    kind: 'dashboard.changed',
                }),
            );
            releaseSlowSend.resolve();
            await vi.waitFor(() =>
                expect(sent.filter((payload) => payload.type === 'stream')).toHaveLength(44),
            );
            expect(
                sent
                    .filter((payload) => payload.type === 'stream')
                    .map((payload) => payload.subscriptionId),
            ).not.toContain(terminalIds[4]);
            subscriptions.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'y'.repeat(256 * 1_024) },
            });
            await vi.waitFor(() =>
                expect(sent.filter((payload) => payload.type === 'stream')).toHaveLength(88),
            );
            expect(
                sent.filter(
                    (payload) => payload.type === 'event' && payload.kind === 'resync-required',
                ),
            ).toHaveLength(1);
        } finally {
            releaseSlowSend.resolve();
            subscriptions.close();
        }
    });

    it('ends only the overflowing subscription and lets another subscription publish', async () => {
        const releaseSlowSend = Promise.withResolvers<void>();
        const sent: MobileServerPayload[] = [];
        let nextId = 0;
        const terminate = vi.fn();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
                if (payload.type === 'stream') await releaseSlowSend.promise;
            },
            terminate,
        });
        const terminalId = await subscriptions.subscribe({
            kind: 'terminal',
            terminalId: 'terminal-1',
        });
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        subscriptions.publish({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'first' },
        });
        await vi.waitFor(() =>
            expect(sent).toContainEqual(expect.objectContaining({ type: 'stream' })),
        );
        for (let index = 0; index < 33; index++)
            subscriptions.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: `queued-${index}` },
            });
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: terminalId,
                sequence: 1,
                kind: 'resync-required',
                reason: 'capacity',
            }),
        );
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: dashboardId,
                sequence: 0,
                kind: 'dashboard.changed',
            }),
        );
        releaseSlowSend.resolve();
        await Promise.resolve();
        expect(sent.filter((payload) => payload.type === 'stream')).toHaveLength(1);
        expect(terminate).not.toHaveBeenCalled();
        subscriptions.close();
    });

    it('revalidates current grants before each push and terminates a stale connection', async () => {
        let isAllowed = true;
        const send = vi.fn(async () => {});
        const terminate = vi.fn();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            currentPrincipal: () => principal,
            matches: () =>
                isAllowed ? Promise.resolve(true) : Promise.reject(new Error('Grant changed')),
            randomId: () => 'subscription-1',
            send,
            terminate,
        });
        await subscriptions.subscribe({ kind: 'dashboard' });
        isAllowed = false;
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
        expect(send).not.toHaveBeenCalled();
        subscriptions.close();
    });
});
