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
                decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
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
            decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
            detachAll: vi.fn(),
            logFailure,
            terminateAll: vi.fn(),
        });

        expect(logFailure).toHaveBeenCalledWith('Runtime unavailable');
        expect(close).toHaveBeenCalledOnce();
    });

    it('coalesces repeated close requests while a decision is pending', async () => {
        const unsaved = Promise.withResolvers<'continue'>();
        const decideUnsavedEditors = vi.fn(() => unsaved.promise);
        const close = vi.fn();
        const requestClose = createWindowCloseHandler({
            close,
            confirm: vi.fn(),
            countRunning: vi.fn().mockResolvedValue(0),
            decideUnsavedEditors,
            detachAll: vi.fn(),
            logFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        const first = requestClose();
        const second = requestClose();
        expect(decideUnsavedEditors).toHaveBeenCalledOnce();
        unsaved.resolve('continue');
        await Promise.all([first, second]);
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('windowClosePrompt', () => {
    it('asks to close the window and names the running Terminals and Chats, not the Server', () => {
        expect(windowClosePrompt(1)).toMatchObject({
            title: 'Close this window?',
            message: 'Close this window while 1 Terminal or Chat is running?',
            buttons: ['Keep Running', 'Terminate and Close', 'Cancel'],
            cancelId: 2,
            defaultId: 2,
        });
        const prompt = windowClosePrompt(3);
        expect(prompt.message).toBe('Close this window while 3 Terminals or Chats are running?');
        expect(prompt.detail).toContain('keeps them running in the background');
        expect(prompt.detail).not.toContain('Server');
    });
});

describe('resolveWindowClose unsaved Editor buffers', () => {
    it('keeps the window open without asking about tasks when unsaved buffers are cancelled', async () => {
        const close = vi.fn();
        const countRunning = vi.fn().mockResolvedValue(1);

        await resolveWindowClose({
            close,
            confirm: vi.fn(),
            countRunning,
            decideUnsavedEditors: vi.fn().mockResolvedValue('cancel'),
            detachAll: vi.fn(),
            logFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        expect(countRunning).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it('decides unsaved buffers before counting running tasks', async () => {
        const calls: string[] = [];

        await resolveWindowClose({
            close: () => calls.push('close'),
            confirm: vi.fn(),
            countRunning: () => {
                calls.push('count');
                return Promise.resolve(0);
            },
            decideUnsavedEditors: () => {
                calls.push('unsaved');
                return Promise.resolve('continue');
            },
            detachAll: () => {
                calls.push('detach');
                return Promise.resolve();
            },
            logFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        expect(calls).toEqual(['unsaved', 'count', 'detach', 'close']);
    });
});
