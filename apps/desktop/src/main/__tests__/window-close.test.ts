import { errorLogFields } from '@caxri/system';
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
                countRunning: vi.fn().mockResolvedValue({ terminals: 0, chats: 1 }),
                decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
                detachAll,
                logFailure: vi.fn(),
                notifyStopFailure: vi.fn(),
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
            notifyStopFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        expect(logFailure).toHaveBeenCalledWith(
            'countRunning',
            errorLogFields(new Error('Runtime unavailable')),
            expect.any(String),
        );
        expect(close).toHaveBeenCalledOnce();
    });

    it('coalesces repeated close requests while a decision is pending', async () => {
        const unsaved = Promise.withResolvers<'continue'>();
        const decideUnsavedEditors = vi.fn(() => unsaved.promise);
        const close = vi.fn();
        const requestClose = createWindowCloseHandler({
            close,
            confirm: vi.fn(),
            countRunning: vi.fn().mockResolvedValue({ terminals: 0, chats: 0 }),
            decideUnsavedEditors,
            detachAll: vi.fn(),
            logFailure: vi.fn(),
            notifyStopFailure: vi.fn(),
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

describe('resolveWindowClose stage failures', () => {
    const base = () => ({
        close: vi.fn(),
        confirm: vi.fn().mockResolvedValue('terminate'),
        countRunning: vi.fn().mockResolvedValue({ terminals: 1, chats: 0 }),
        decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
        detachAll: vi.fn().mockResolvedValue(undefined),
        logFailure: vi.fn(),
        notifyStopFailure: vi.fn().mockResolvedValue(undefined),
        terminateAll: vi.fn().mockResolvedValue(undefined),
    });

    it('tells the user and then closes when an explicit Terminate fails', async () => {
        const options = base();
        const error = new Error('Server wedged');
        options.terminateAll.mockRejectedValue(error);

        await resolveWindowClose(options);

        expect(options.logFailure).toHaveBeenCalledWith(
            'terminate',
            errorLogFields(error),
            expect.any(String),
        );
        expect(options.notifyStopFailure).toHaveBeenCalledOnce();
        expect(options.close).toHaveBeenCalledOnce();
    });

    it('closes without a notification when detaching fails', async () => {
        const options = base();
        options.confirm.mockResolvedValue('close');
        options.detachAll.mockRejectedValue(new Error('detach failed'));

        await resolveWindowClose(options);

        expect(options.logFailure).toHaveBeenCalledWith(
            'detach',
            expect.anything(),
            expect.any(String),
        );
        expect(options.notifyStopFailure).not.toHaveBeenCalled();
        expect(options.close).toHaveBeenCalledOnce();
    });

    it('closes and detaches when the confirmation fails', async () => {
        const options = base();
        options.confirm.mockRejectedValue(new Error('dialog failed'));

        await resolveWindowClose(options);

        expect(options.logFailure).toHaveBeenCalledWith(
            'confirm',
            expect.anything(),
            expect.any(String),
        );
        expect(options.terminateAll).not.toHaveBeenCalled();
        expect(options.notifyStopFailure).not.toHaveBeenCalled();
        expect(options.close).toHaveBeenCalledOnce();
    });
});

describe('windowClosePrompt', () => {
    it('asks to close the window in one line and names the running Terminals and Chats in another', () => {
        expect(windowClosePrompt({ terminals: 1, chats: 0 })).toMatchObject({
            title: 'Close this window?',
            message: 'Close this window?',
            detail: 'Running: 1 Terminal',
            buttons: ['Keep Running', 'Terminate and Close', 'Cancel'],
            cancelId: 2,
            defaultId: 0,
        });
    });

    it.each([
        [{ terminals: 0, chats: 1 }, 'Running: 1 Chat'],
        [{ terminals: 3, chats: 0 }, 'Running: 3 Terminals'],
        [{ terminals: 1, chats: 2 }, 'Running: 1 Terminal and 2 Chats'],
    ])('leaves out a kind with nothing running (%o)', (running, detail) => {
        expect(windowClosePrompt(running).detail).toBe(detail);
    });
});

describe('resolveWindowClose unsaved Editor buffers', () => {
    it('keeps the window open without asking about tasks when unsaved buffers are cancelled', async () => {
        const close = vi.fn();
        const countRunning = vi.fn().mockResolvedValue({ terminals: 1, chats: 0 });

        await resolveWindowClose({
            close,
            confirm: vi.fn(),
            countRunning,
            decideUnsavedEditors: vi.fn().mockResolvedValue('cancel'),
            detachAll: vi.fn(),
            logFailure: vi.fn(),
            notifyStopFailure: vi.fn(),
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
                return Promise.resolve({ terminals: 0, chats: 0 });
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
            notifyStopFailure: vi.fn(),
            terminateAll: vi.fn(),
        });

        expect(calls).toEqual(['unsaved', 'count', 'detach', 'close']);
    });
});
