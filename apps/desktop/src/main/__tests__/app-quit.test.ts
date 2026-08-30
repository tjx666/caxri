import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AppQuitOptions } from '../app-quit';
import {
    appQuitPrompt,
    confirmAppQuit,
    createAppQuitHandler,
    notifyAppQuitStopFailure,
    resolveAppQuit,
} from '../app-quit';

function options(overrides: Partial<AppQuitOptions> = {}): AppQuitOptions {
    return {
        acceptQuit: vi.fn(),
        closeDesktop: vi.fn().mockResolvedValue(undefined),
        confirm: vi.fn().mockResolvedValue('keep-running'),
        detachAll: vi.fn().mockResolvedValue(undefined),
        exit: vi.fn(),
        quitIntent: () => 'user',
        logFailure: vi.fn(),
        notifyStopFailure: vi.fn().mockResolvedValue(undefined),
        persistWindowState: vi.fn().mockResolvedValue(undefined),
        readStatus: vi.fn().mockResolvedValue({ activePtyCount: 0, clientCount: 1 }),
        stopServer: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('resolveAppQuit', () => {
    it('stops an idle Server when Desktop is its only client', async () => {
        const calls: string[] = [];
        const target = options({
            acceptQuit: () => calls.push('accept'),
            persistWindowState: () => {
                calls.push('persist');
                return Promise.resolve();
            },
            stopServer: () => {
                calls.push('stop');
                return Promise.resolve();
            },
            closeDesktop: vi.fn(() => {
                calls.push('close');
                return Promise.resolve();
            }),
            exit: () => calls.push('exit'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(calls).toEqual(['accept', 'persist', 'stop', 'close', 'exit']);
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.detachAll).not.toHaveBeenCalled();
        expect(target.closeDesktop).toHaveBeenCalledOnce();
    });

    it('keeps an idle Server for another connected client without prompting', async () => {
        const target = options({
            readStatus: vi.fn().mockResolvedValue({ activePtyCount: 0, clientCount: 2 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('kept-running');

        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.detachAll).toHaveBeenCalledOnce();
        expect(target.closeDesktop).toHaveBeenCalledOnce();
        expect(target.stopServer).not.toHaveBeenCalled();
        expect(target.exit).toHaveBeenCalledOnce();
    });

    it.each([
        ['cancel', 'cancelled', false, false, false],
        ['keep-running', 'kept-running', true, false, true],
        ['stop', 'stopped', false, true, true],
    ] as const)(
        'maps the %s decision for live tasks to the %s outcome',
        async (decision, outcome, shouldDetach, shouldStop, shouldExit) => {
            const target = options({
                confirm: vi.fn().mockResolvedValue(decision),
                readStatus: vi.fn().mockResolvedValue({ activePtyCount: 3, clientCount: 4 }),
            });

            await expect(resolveAppQuit(target)).resolves.toBe(outcome);

            expect(target.confirm).toHaveBeenCalledWith({
                activePtyCount: 3,
                otherClientCount: 3,
            });
            expect(target.detachAll).toHaveBeenCalledTimes(shouldDetach ? 1 : 0);
            expect(target.stopServer).toHaveBeenCalledTimes(shouldStop ? 1 : 0);
            expect(target.closeDesktop).toHaveBeenCalledTimes(shouldExit ? 1 : 0);
            expect(target.acceptQuit).toHaveBeenCalledTimes(shouldExit ? 1 : 0);
            expect(target.exit).toHaveBeenCalledTimes(shouldExit ? 1 : 0);
        },
    );

    it('keeps the Server when status cannot be read so Desktop can still quit safely', async () => {
        const target = options({
            readStatus: vi
                .fn()
                .mockRejectedValue(new CaxriError('UNAVAILABLE', 'Server unavailable')),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('kept-running');

        expect(target.logFailure).toHaveBeenCalledWith('warn', 'status', 'Server unavailable');
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.detachAll).toHaveBeenCalledOnce();
        expect(target.closeDesktop).toHaveBeenCalledOnce();
        expect(target.exit).toHaveBeenCalledOnce();
    });

    it.each(['system-shutdown', 'relaunch'] as const)(
        'keeps work without prompting for the %s intent',
        async (intent) => {
            const target = options({
                quitIntent: () => intent,
                readStatus: vi.fn().mockResolvedValue({ activePtyCount: 2, clientCount: 1 }),
            });

            await expect(resolveAppQuit(target)).resolves.toBe('kept-running');

            expect(target.readStatus).not.toHaveBeenCalled();
            expect(target.confirm).not.toHaveBeenCalled();
            expect(target.detachAll).toHaveBeenCalledOnce();
        },
    );

    it('exits after best-effort shutdown failures and reports their owning stages', async () => {
        const target = options({
            persistWindowState: vi.fn().mockRejectedValue(new Error('persist failed')),
            stopServer: vi.fn().mockRejectedValue(new Error('stop failed')),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stop-failed');

        expect(target.logFailure).toHaveBeenNthCalledWith(1, 'error', 'persist', 'persist failed');
        expect(target.logFailure).toHaveBeenNthCalledWith(2, 'error', 'stop', 'stop failed');
        expect(target.notifyStopFailure).toHaveBeenCalledOnce();
        expect(target.exit).toHaveBeenCalledOnce();
    });
});

describe('createAppQuitHandler', () => {
    it('coalesces repeated quit requests and permits another request after cancellation', async () => {
        const status = Promise.withResolvers<{ activePtyCount: number; clientCount: number }>();
        const readStatus = vi
            .fn()
            .mockReturnValueOnce(status.promise)
            .mockResolvedValueOnce({ activePtyCount: 1, clientCount: 1 });
        const confirm = vi.fn().mockResolvedValue('cancel');
        const requestQuit = createAppQuitHandler(options({ confirm, readStatus }));

        const first = requestQuit();
        const second = requestQuit();
        expect(first).toBe(second);
        expect(readStatus).toHaveBeenCalledOnce();
        status.resolve({ activePtyCount: 1, clientCount: 1 });
        await first;

        await requestQuit();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

describe('appQuitPrompt', () => {
    it('explains session portability and other-client impact without defaulting to destruction', () => {
        expect(appQuitPrompt({ activePtyCount: 2, otherClientCount: 1 })).toEqual({
            buttons: ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'],
            cancelId: 2,
            defaultId: 1,
            detail: 'Quit and Stop Tasks ends every running Terminal and Agent process, releases Agent sessions so they can be resumed in other tools, and stops Caxri Server. Quit and Keep Tasks Running leaves them attached to Caxri in the background.\n\n1 other client is connected to Caxri Server. Stopping will disconnect it.',
            message: '2 tasks are still running.',
            title: 'Quit Caxri?',
            type: 'warning',
        });
    });

    it('shows the native prompt without a parent when no window remains', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
        const impact = { activePtyCount: 1, otherClientCount: 0 };

        await expect(confirmAppQuit({ showMessageBox } as never, undefined, impact)).resolves.toBe(
            'keep-running',
        );
        expect(showMessageBox).toHaveBeenCalledWith(appQuitPrompt(impact));
    });

    it('warns before fail-open exit when the accepted stop action fails', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });

        await notifyAppQuitStopFailure({ showMessageBox } as never, undefined);

        expect(showMessageBox).toHaveBeenCalledWith({
            buttons: ['Quit Anyway'],
            cancelId: 0,
            defaultId: 0,
            detail: 'Caxri will quit now. Reopen Caxri to stop any remaining tasks before resuming their Agent sessions in another tool.',
            message: 'Some background tasks may still be running.',
            title: "Caxri Couldn't Stop All Tasks",
            type: 'error',
        });
    });
});
