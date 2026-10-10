import { describe, expect, it, vi } from 'vitest';

import { createWindowCloseHandler, resolveWindowClose, windowClosePrompt } from '../window-close';

describe('resolveWindowClose', () => {
    it.each([
        ['close', false, true, true],
        ['terminate', true, false, true],
        ['cancel', false, false, false],
    ] as const)(
        'maps the %s decision to terminate=%s, detach=%s, and close=%s',
        async (decision, shouldTerminate, shouldDetach, shouldClose) => {
            const close = vi.fn();
            const detachAll = vi.fn();
            const terminateAll = vi.fn();

            await resolveWindowClose({
                close,
                confirm: vi.fn().mockResolvedValue(decision),
                countRunning: vi.fn().mockResolvedValue(1),
                detachAll,
                logFailure: vi.fn(),
                terminateAll,
            });

            expect(terminateAll).toHaveBeenCalledTimes(shouldTerminate ? 1 : 0);
            expect(detachAll).toHaveBeenCalledTimes(shouldDetach ? 1 : 0);
            expect(close).toHaveBeenCalledTimes(shouldClose ? 1 : 0);
        },
    );

    it('logs and closes when Runtime terminal counting fails', async () => {
        const close = vi.fn();
        const logFailure = vi.fn();

        await resolveWindowClose({
            close,
            confirm: vi.fn(),
            countRunning: vi.fn().mockRejectedValue(new Error('Runtime unavailable')),
            detachAll: vi.fn(),
            logFailure,
            terminateAll: vi.fn(),
        });

        expect(logFailure).toHaveBeenCalledWith('Runtime unavailable');
        expect(close).toHaveBeenCalledOnce();
    });

    it('coalesces repeated close requests while a decision is pending', async () => {
        const count = Promise.withResolvers<number>();
        const countRunning = vi.fn(() => count.promise);
        const close = vi.fn();
        const requestClose = createWindowCloseHandler({
            close,
            confirm: vi.fn(),
            countRunning,
            detachAll: vi.fn(),
            logFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        const first = requestClose();
        const second = requestClose();
        expect(countRunning).toHaveBeenCalledOnce();
        count.resolve(0);
        await Promise.all([first, second]);
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('windowClosePrompt', () => {
    it('counts running tasks, not Terminals, and avoids naming the Server', () => {
        expect(windowClosePrompt(1)).toMatchObject({
            title: 'Tasks are still running',
            message: '1 task is still running.',
        });
        const prompt = windowClosePrompt(3);
        expect(prompt.message).toBe('3 tasks are still running.');
        expect(prompt.detail).toContain('keeps them running in the background');
        expect(prompt.detail).not.toContain('Server');
    });
});
