import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MobileFrameRouter } from '../mobile-frame-router';

const reply = (id: string, result: unknown) => ({
    protocolVersion: CAXRI_PROTOCOL_VERSION,
    id,
    ok: true as const,
    result,
});

describe('mobile frame router', () => {
    it('routes changes invalidations only to the Changes subscription', () => {
        const router = new MobileFrameRouter();
        const onChanges = vi.fn();
        router.addSubscription(
            'changes-sub',
            { kind: 'changes', sessionId: 'session-1' },
            onChanges,
        );
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'changes-sub',
            sequence: 0,
            kind: 'changes.changed',
        });
        expect(onChanges).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'changes.changed' }),
        );
        expect(() =>
            router.receiveSubscriptionMessage({
                type: 'event',
                subscriptionId: 'changes-sub',
                sequence: 1,
                kind: 'dashboard.changed',
            }),
        ).toThrow('wrong resource');
    });

    it('routes extension view hints only to the extension views subscription', () => {
        const router = new MobileFrameRouter();
        const onViews = vi.fn();
        router.addSubscription(
            'views-sub',
            { kind: 'extensionViews', sessionId: 'session-1' },
            onViews,
        );
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'views-sub',
            sequence: 0,
            kind: 'extensionViews.changed',
        });
        expect(onViews).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'extensionViews.changed' }),
        );
        expect(() =>
            router.receiveSubscriptionMessage({
                type: 'event',
                subscriptionId: 'views-sub',
                sequence: 1,
                kind: 'changes.changed',
            }),
        ).toThrow('wrong resource');
    });

    it('resolves simultaneous requests by ID when replies arrive in reverse order', async () => {
        const router = new MobileFrameRouter();
        const first = router.waitForReply('first', 15_000, vi.fn());
        const second = router.waitForReply('second', 15_000, vi.fn());
        router.receiveReply(reply('second', { value: 2 }));
        router.receiveReply(reply('first', { value: 1 }));
        await expect(first).resolves.toMatchObject({ id: 'first', result: { value: 1 } });
        await expect(second).resolves.toMatchObject({ id: 'second', result: { value: 2 } });
    });

    it('keeps event and stream sequences separate by subscription while replies are pending', async () => {
        const router = new MobileFrameRouter();
        const dashboard = vi.fn();
        const terminal = vi.fn();
        router.addSubscription('dashboard-sub', { kind: 'dashboard' }, dashboard);
        router.addSubscription(
            'terminal-sub',
            { kind: 'terminal', terminalId: 'terminal-1' },
            terminal,
        );
        const response = router.waitForReply('read', 3_000, vi.fn());
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'dashboard-sub',
            sequence: 0,
            kind: 'dashboard.changed',
        });
        router.receiveSubscriptionMessage({
            type: 'stream',
            subscriptionId: 'terminal-sub',
            sequence: 0,
            kind: 'terminal.output',
            generation: 1,
            hostSequence: 0,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: '6162',
        });
        router.receiveReply(reply('read', { result: true }));
        await expect(response).resolves.toMatchObject({ id: 'read' });
        expect(dashboard).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'dashboard.changed', sequence: 0 }),
        );
        expect(terminal).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'terminal.output', chunkHex: '6162' }),
        );
    });

    it('rejects sequence gaps and stops delivering after unsubscribe or resync', () => {
        const router = new MobileFrameRouter();
        const onMessage = vi.fn();
        router.addSubscription('subscription-1', { kind: 'dashboard' }, onMessage);
        expect(() =>
            router.receiveSubscriptionMessage({
                type: 'event',
                subscriptionId: 'subscription-1',
                sequence: 1,
                kind: 'dashboard.changed',
            }),
        ).toThrow('sequence');
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'subscription-1',
            sequence: 0,
            kind: 'resync-required',
            reason: 'capacity',
        });
        expect(onMessage).toHaveBeenCalledOnce();
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'subscription-1',
            sequence: 1,
            kind: 'dashboard.changed',
        });
        expect(onMessage).toHaveBeenCalledOnce();
    });

    it('replays a bounded pre-ACK resync before the subscription becomes visible', () => {
        const router = new MobileFrameRouter();
        const onMessage = vi.fn();
        router.beginSubscriptionRequest('subscribe-1');
        router.receiveSubscriptionMessage({
            type: 'event',
            subscriptionId: 'early-subscription',
            sequence: 0,
            kind: 'resync-required',
            reason: 'capacity',
        });
        router.addSubscription('early-subscription', { kind: 'dashboard' }, onMessage);
        router.endSubscriptionRequest('subscribe-1');
        expect(onMessage).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'resync-required', sequence: 0 }),
        );
        expect(router.hasSubscription('early-subscription')).toBe(false);
    });

    it('accepts the first Terminal snapshot after subscription ACK before output', () => {
        const router = new MobileFrameRouter();
        const onMessage = vi.fn();
        router.beginSubscriptionRequest('subscribe-terminal');
        router.addSubscription(
            'terminal-sub',
            { kind: 'terminal', terminalId: 'terminal-1' },
            onMessage,
        );
        router.endSubscriptionRequest('subscribe-terminal');
        router.receiveSubscriptionMessage({
            type: 'stream',
            subscriptionId: 'terminal-sub',
            sequence: 0,
            kind: 'terminal.snapshot',
            generation: 2,
            nextHostSequence: 7,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: '6e756c6c',
        });
        router.receiveSubscriptionMessage({
            type: 'stream',
            subscriptionId: 'terminal-sub',
            sequence: 1,
            kind: 'terminal.output',
            generation: 2,
            hostSequence: 7,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: '41',
        });
        expect(onMessage).toHaveBeenCalledTimes(2);
        expect(onMessage).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ kind: 'terminal.snapshot' }),
        );
        expect(onMessage).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ kind: 'terminal.output' }),
        );
    });

    it('rejects unknown push floods instead of accumulating unbounded pre-ACK frames', () => {
        const router = new MobileFrameRouter();
        router.beginSubscriptionRequest('subscribe-1');
        for (let index = 0; index < 32; index += 1)
            router.receiveSubscriptionMessage({
                type: 'event',
                subscriptionId: `unknown-${index}`,
                sequence: 0,
                kind: 'dashboard.changed',
            });
        expect(() =>
            router.receiveSubscriptionMessage({
                type: 'event',
                subscriptionId: 'unknown-overflow',
                sequence: 0,
                kind: 'dashboard.changed',
            }),
        ).toThrow('pre-ACK');
    });

    it('rejects unknown events without a pending subscribe and clears orphaned frames on failure', () => {
        const router = new MobileFrameRouter();
        const early = {
            type: 'event' as const,
            subscriptionId: 'orphan-subscription',
            sequence: 0,
            kind: 'dashboard.changed' as const,
        };
        expect(() => router.receiveSubscriptionMessage(early)).toThrow('unexpected subscription');
        router.beginSubscriptionRequest('subscribe-1');
        router.receiveSubscriptionMessage(early);
        router.endSubscriptionRequest('subscribe-1');
        router.beginSubscriptionRequest('subscribe-2');
        const onMessage = vi.fn();
        router.addSubscription('orphan-subscription', { kind: 'dashboard' }, onMessage);
        expect(onMessage).not.toHaveBeenCalled();
        router.endSubscriptionRequest('subscribe-2');
    });
});
