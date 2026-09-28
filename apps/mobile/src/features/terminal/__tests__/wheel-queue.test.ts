import { describe, expect, it, vi } from 'vitest';

import {
    canForwardTerminalWheel,
    createTerminalWheelForwarder,
    createTerminalWheelQueue,
} from '../wheel-queue';

describe('mobile Terminal wheel queue', () => {
    it('folds frames that arrive during a request into one bounded follow-up', async () => {
        const send = vi.fn(() => Promise.resolve(null));
        const queue = createTerminalWheelQueue(send, vi.fn());
        queue.add({ col: 3, lines: -2, row: 4 });
        queue.add({ col: 3, lines: -30, row: 4 });
        queue.add({ col: 5, lines: -40, row: 6 });
        expect(send).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
        expect(send.mock.calls).toEqual([
            [{ col: 3, lines: -2, row: 4 }],
            [{ col: 5, lines: -50, row: 6 }],
            [{ col: 5, lines: -20, row: 6 }],
        ]);
    });

    it('drops pending frames after a failure instead of replaying stale scrolls', async () => {
        const onError = vi.fn();
        const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
        const queue = createTerminalWheelQueue(send, onError);
        queue.add({ col: 1, lines: 3, row: 1 });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        queue.add({ col: 1, lines: 1, row: 1 });
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send).toHaveBeenLastCalledWith({ col: 1, lines: 1, row: 1 });
    });
});

describe('mobile Terminal wheel forwarding', () => {
    const target = {
        expectedGeneration: 2,
        subscriptionId: 'subscription-1',
        terminalId: 'terminal-1',
    };
    const wheel = { col: 4, lines: -3, row: 7 };

    it('lets only a control device forward drags as Terminal scrolls', () => {
        expect(canForwardTerminalWheel('control')).toBe(true);
        expect(canForwardTerminalWheel('reply')).toBe(false);
        expect(canForwardTerminalWheel('view')).toBe(false);
        expect(canForwardTerminalWheel(null)).toBe(false);
    });

    it.each(['view', 'reply', null] as const)(
        'never sends mobile.terminal.scroll for a %s device',
        async (role) => {
            const request = vi.fn(() => Promise.resolve(null));
            const onError = vi.fn();
            const forward = createTerminalWheelForwarder({
                onError,
                request,
                target: () => target,
            });
            expect(forward(role, wheel)).toBe(false);
            expect(forward(role, { ...wheel, lines: 5 })).toBe(false);
            await Promise.resolve();
            expect(request).not.toHaveBeenCalled();
            expect(onError).not.toHaveBeenCalled();
        },
    );

    it('sends a control device drag to the current control target', async () => {
        const request = vi.fn(() => Promise.resolve(null));
        const forward = createTerminalWheelForwarder({
            onError: vi.fn(),
            request,
            target: () => target,
        });
        expect(forward('control', wheel)).toBe(true);
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        expect(request).toHaveBeenCalledWith('mobile.terminal.scroll', { ...target, ...wheel });
    });

    it('drops a control drag once the stream no longer has a control target', async () => {
        const request = vi.fn(() => Promise.resolve(null));
        const forward = createTerminalWheelForwarder({
            onError: vi.fn(),
            request,
            target: () => null,
        });
        expect(forward('control', wheel)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
    });

    it('stops forwarding after the device drops from control to view', async () => {
        const request = vi.fn(() => Promise.resolve(null));
        const forward = createTerminalWheelForwarder({
            onError: vi.fn(),
            request,
            target: () => target,
        });
        forward('control', wheel);
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        expect(forward('view', { ...wheel, lines: 8 })).toBe(false);
        await Promise.resolve();
        expect(request).toHaveBeenCalledOnce();
    });
});
