import { describe, expect, it, vi } from 'vitest';

import { createWindowCloseHandler, resolveWindowClose } from '../window-close';

describe('resolveWindowClose', () => {
    it.each([
        ['close', false, true],
        ['terminate', true, true],
        ['cancel', false, false],
    ] as const)(
        'maps the %s decision to terminate=%s and close=%s',
        async (decision, shouldTerminate, shouldClose) => {
            const close = vi.fn();
            const terminateAll = vi.fn();

            await resolveWindowClose({
                close,
                confirm: vi.fn().mockResolvedValue(decision),
                countRunning: vi.fn().mockResolvedValue(1),
                logFailure: vi.fn(),
                terminateAll,
            });

            expect(terminateAll).toHaveBeenCalledTimes(shouldTerminate ? 1 : 0);
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
