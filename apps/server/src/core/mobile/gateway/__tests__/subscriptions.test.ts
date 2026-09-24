import type { MobileServerPayload } from '@caxri/mobile-transport';
// oxlint-disable typescript/require-await -- Async Host and authorization fakes preserve the production Promise boundary.
import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../../domains/terminal';
import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};
const port = () => ({
    observe: vi.fn(async () => ({ snapshot: null, generation: 1, nextSequence: 0 })),
    unobserve: vi.fn(async () => {}),
    releaseTakeOver: vi.fn(async () => {}),
});

describe('MobileGatewaySubscriptions', () => {
    it('streams a normal 256 KiB Host batch without a capacity resync', async () => {
        const sent: MobileServerPayload[] = [];
        const execution = port();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'subscription-terminal',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        const id = await subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' });
        expect(sent).toEqual([]);
        subscriptions.activate(id);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        subscriptions.publishObserverEvent({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 0,
            data: 'x'.repeat(256 * 1_024),
        });
        await vi.waitFor(() =>
            expect(sent.filter((frame) => frame.type === 'stream')).toHaveLength(12),
        );
        expect(sent.filter((frame) => frame.type === 'event')).toHaveLength(0);
        subscriptions.close();
        await vi.waitFor(() =>
            expect(execution.unobserve).toHaveBeenCalledWith(
                'terminal-1',
                'connection-1:subscription-terminal',
            ),
        );
    });

    it('limits subscriptions whose authorization resolves concurrently', async () => {
        const release = Promise.withResolvers<void>();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => release.promise,
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async () => {},
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const attempts = Array.from({ length: 33 }, () =>
            subscriptions.subscribe({ kind: 'dashboard' }),
        );
        release.resolve();
        const results = await Promise.allSettled(attempts);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        subscriptions.close();
    });

    it('rejects a duplicate Terminal observer on one connection while dashboard still pushes', async () => {
        const sent: MobileServerPayload[] = [];
        const execution = port();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        await subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' });
        await expect(
            subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: dashboardId,
                sequence: 0,
                kind: 'dashboard.changed',
            }),
        );
        subscriptions.close();
    });

    it('isolates a slow Terminal observer after capacity overflow', async () => {
        const sent: MobileServerPayload[] = [];
        const release = Promise.withResolvers<void>();
        const execution = port();
        const terminate = vi.fn();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
                if (payload.type === 'stream' && payload.kind === 'terminal.output')
                    await release.promise;
            },
            terminate,
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        const terminalId = await subscriptions.subscribe({
            kind: 'terminal',
            terminalId: 'terminal-1',
        });
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        subscriptions.activate(terminalId);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        subscriptions.publishObserverEvent({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 0,
            data: 'first',
        });
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        for (let index = 1; index < 100; index++)
            subscriptions.publishObserverEvent({
                type: 'output',
                terminalId: 'terminal-1',
                generation: 1,
                sequence: index,
                data: 'x'.repeat(8 * 1_024),
            });
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        release.resolve();
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: terminalId,
                sequence: 2,
                kind: 'resync-required',
                reason: 'capacity',
            }),
        );
        expect(sent).toContainEqual({
            type: 'event',
            subscriptionId: dashboardId,
            sequence: 0,
            kind: 'dashboard.changed',
        });
        expect(terminate).not.toHaveBeenCalled();
        subscriptions.close();
    });

    it('revalidates current grants before each dashboard push', async () => {
        let isAllowed = true;
        const send = vi.fn(async () => {});
        const terminate = vi.fn();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => {
                if (!isAllowed) throw new Error('Grant changed');
                return true;
            },
            randomId: () => 'subscription-1',
            send,
            terminate,
            connectionId: 'connection-1',
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
