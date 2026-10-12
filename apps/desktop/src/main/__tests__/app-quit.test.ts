import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AppQuitOptions } from '../app-quit';
import {
    appQuitPrompt,
    confirmAppQuit,
    confirmPendingReviewCommentsQuit,
    createAppQuitHandler,
    createAppQuitPromptOptions,
    notifyAppQuitStopFailure,
    pendingReviewCommentsPrompt,
    resolveAppQuit,
} from '../app-quit';

function options(overrides: Partial<AppQuitOptions> = {}): AppQuitOptions {
    return {
        acceptQuit: vi.fn(),
        closeDesktop: vi.fn().mockResolvedValue(undefined),
        confirm: vi.fn().mockResolvedValue('keep-running'),
        confirmPendingReviewComments: vi.fn().mockResolvedValue('discard'),
        decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
        detachAll: vi.fn().mockResolvedValue(undefined),
        exit: vi.fn(),
        quitIntent: () => 'user',
        logFailure: vi.fn(),
        notifyStopFailure: vi.fn().mockResolvedValue(undefined),
        persistWindowState: vi.fn().mockResolvedValue(undefined),
        readPendingReviewComments: vi.fn().mockResolvedValue({ count: 0, groups: [] }),
        readStatus: vi.fn().mockResolvedValue({ activePtyCount: 0, clientCount: 1 }),
        stopServer: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('resolveAppQuit', () => {
    it('cancels before any other prompt when unsaved Editor buffers are kept', async () => {
        const target = options({
            decideUnsavedEditors: vi.fn().mockResolvedValue('cancel'),
            readStatus: vi.fn().mockResolvedValue({ activePtyCount: 2, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.readPendingReviewComments).not.toHaveBeenCalled();
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.acceptQuit).not.toHaveBeenCalled();
        expect(target.exit).not.toHaveBeenCalled();
    });

    it('continues into the existing quit flow once unsaved buffers are resolved', async () => {
        const target = options({
            readStatus: vi.fn().mockResolvedValue({ activePtyCount: 1, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('kept-running');

        expect(target.decideUnsavedEditors).toHaveBeenCalledOnce();
        expect(target.confirm).toHaveBeenCalledOnce();
    });

    it('does not consult unsaved buffers for a system shutdown', async () => {
        const target = options({ quitIntent: () => 'system-shutdown' });

        await resolveAppQuit(target);

        expect(target.decideUnsavedEditors).not.toHaveBeenCalled();
    });

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

            expect(target.readPendingReviewComments).not.toHaveBeenCalled();
            expect(target.readStatus).not.toHaveBeenCalled();
            expect(target.confirm).not.toHaveBeenCalled();
            expect(target.detachAll).toHaveBeenCalledOnce();
        },
    );

    it('cancels the quit when the user declines to lose pending review comments, without reaching the task decision', async () => {
        const target = options({
            readPendingReviewComments: vi.fn().mockResolvedValue({
                count: 2,
                groups: [
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-1',
                        repositoryName: 'caxri',
                        count: 2,
                    },
                ],
            }),
            confirmPendingReviewComments: vi.fn().mockResolvedValue('cancel'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.confirmPendingReviewComments).toHaveBeenCalledWith({
            count: 2,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'caxri',
                    count: 2,
                },
            ],
        });
        expect(target.readStatus).not.toHaveBeenCalled();
        expect(target.acceptQuit).not.toHaveBeenCalled();
    });

    it('continues quitting after discarding pending review comments', async () => {
        const target = options({
            readPendingReviewComments: vi.fn().mockResolvedValue({
                count: 1,
                groups: [
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-1',
                        repositoryName: 'caxri',
                        count: 1,
                    },
                ],
            }),
            confirmPendingReviewComments: vi.fn().mockResolvedValue('discard'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.readStatus).toHaveBeenCalledOnce();
    });

    it('fails open and continues quitting when pending review comments cannot be read', async () => {
        const target = options({
            readPendingReviewComments: vi.fn().mockRejectedValue(new Error('Server unavailable')),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.logFailure).toHaveBeenCalledWith(
            'error',
            'reviewComments',
            'Server unavailable',
        );
        expect(target.confirmPendingReviewComments).not.toHaveBeenCalled();
    });

    it('fails open and continues quitting when the pending review comments prompt itself fails', async () => {
        const target = options({
            readPendingReviewComments: vi.fn().mockResolvedValue({
                count: 1,
                groups: [
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-1',
                        repositoryName: 'caxri',
                        count: 1,
                    },
                ],
            }),
            confirmPendingReviewComments: vi.fn().mockRejectedValue(new Error('dialog failed')),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.logFailure).toHaveBeenCalledWith('error', 'reviewComments', 'dialog failed');
    });

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
        // `decidePendingReviewComments` now awaits its own Server round-trip before `readStatus` runs, adding a
        // microtask hop ahead of it; wait for that hop to settle instead of asserting immediately after the call.
        await vi.waitFor(() => expect(readStatus).toHaveBeenCalledOnce());
        status.resolve({ activePtyCount: 1, clientCount: 1 });
        await first;

        await requestQuit();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it('accepts a termination signal while the quit prompt is still open instead of waiting on it', async () => {
        const prompt = Promise.withResolvers<'stop'>();
        const target = options({
            confirm: vi.fn().mockReturnValue(prompt.promise),
            readStatus: vi.fn().mockResolvedValue({ activePtyCount: 2, clientCount: 1 }),
        });
        const requestQuit = createAppQuitHandler(target);

        const prompted = requestQuit();
        await vi.waitFor(() => expect(target.confirm).toHaveBeenCalledOnce());
        expect(target.acceptQuit).not.toHaveBeenCalled();

        await expect(requestQuit('SIGTERM')).resolves.toBe('kept-running');
        expect(target.acceptQuit).toHaveBeenCalledOnce();
        expect(target.detachAll).toHaveBeenCalledOnce();
        expect(target.stopServer).not.toHaveBeenCalled();
        expect(target.exit).toHaveBeenCalledOnce();

        // Answering the stale prompt afterwards must not run quit acceptance a second time.
        prompt.resolve('stop');
        await prompted;
        expect(target.acceptQuit).toHaveBeenCalledOnce();
    });

    it('lets an already accepted Stop Tasks quit finish when a termination signal arrives mid-stop', async () => {
        const stopping = Promise.withResolvers<void>();
        const target = options({
            confirm: vi.fn().mockResolvedValue('stop'),
            readStatus: vi.fn().mockResolvedValue({ activePtyCount: 2, clientCount: 1 }),
            stopServer: vi.fn().mockReturnValue(stopping.promise),
        });
        const requestQuit = createAppQuitHandler(target);

        const quitting = requestQuit();
        await vi.waitFor(() => expect(target.stopServer).toHaveBeenCalledOnce());
        const signalled = requestQuit('SIGTERM');

        expect(target.detachAll).not.toHaveBeenCalled();
        expect(target.exit).not.toHaveBeenCalled();
        stopping.resolve();
        expect(await signalled).toBe(await quitting);
        expect(target.detachAll).not.toHaveBeenCalled();
        expect(target.acceptQuit).toHaveBeenCalledOnce();
    });
});

describe('appQuitPrompt', () => {
    it('explains session portability and other-client impact without defaulting to destruction', () => {
        expect(appQuitPrompt({ activePtyCount: 2, otherClientCount: 1 })).toEqual({
            buttons: ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'],
            cancelId: 2,
            defaultId: 1,
            detail: 'Quit and Stop Tasks ends every running Terminal and Agent process, releases Agent sessions so they can be resumed in other tools, and stops Caxri Server. Quit and Keep Tasks Running leaves them attached to Caxri in the background.\n\n1 other client is connected to Caxri Server. Stopping will disconnect it.',
            message: 'Quit Caxri while 2 tasks are running?',
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

    it('explains the pending review comment count and repository count without defaulting to discarding them', () => {
        expect(
            pendingReviewCommentsPrompt({
                count: 3,
                groups: [
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-1',
                        repositoryName: 'caxri',
                        count: 2,
                    },
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-2',
                        repositoryName: 'other',
                        count: 1,
                    },
                ],
            }),
        ).toEqual({
            buttons: ['Quit Anyway', 'Cancel'],
            cancelId: 1,
            defaultId: 1,
            detail: 'Review comments live in memory only and do not survive quitting Caxri. 2 repositories have unsent comments.',
            message: 'Quit Caxri and lose 3 pending review comments?',
            title: 'Quit with pending review comments?',
            type: 'warning',
        });
    });

    it('shows the pending review comments prompt without a parent when no window remains', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
        const summary = {
            count: 1,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'caxri',
                    count: 1,
                },
            ],
        };

        await expect(
            confirmPendingReviewCommentsQuit({ showMessageBox } as never, undefined, summary),
        ).resolves.toBe('cancel');
        expect(showMessageBox).toHaveBeenCalledWith(pendingReviewCommentsPrompt(summary));
    });

    it('attaches every quit prompt to a Workbench window created after composition', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
        const summary = {
            count: 1,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'caxri',
                    count: 1,
                },
            ],
        };
        const impact = { activePtyCount: 1, otherClientCount: 0 };
        const mainWindow = { isDestroyed: () => false };
        const getWindow = vi.fn((): typeof mainWindow | undefined => undefined);
        const prompts = createAppQuitPromptOptions({ showMessageBox } as never, getWindow as never);
        // Mirrors `index.ts`: the quit handler is composed before the Workbench window exists.
        getWindow.mockReturnValue(mainWindow);

        await expect(prompts.confirmPendingReviewComments(summary)).resolves.toBe('cancel');
        await expect(prompts.confirm(impact)).resolves.toBe('keep-running');
        await prompts.notifyStopFailure();

        expect(showMessageBox).toHaveBeenNthCalledWith(
            1,
            mainWindow,
            pendingReviewCommentsPrompt(summary),
        );
        expect(showMessageBox).toHaveBeenNthCalledWith(2, mainWindow, appQuitPrompt(impact));
        expect(showMessageBox).toHaveBeenNthCalledWith(
            3,
            mainWindow,
            expect.objectContaining({ title: "Caxri Couldn't Stop All Tasks" }),
        );
    });

    it('resolves to discard when the user picks Quit Anyway', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
        const summary = {
            count: 1,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'caxri',
                    count: 1,
                },
            ],
        };

        await expect(
            confirmPendingReviewCommentsQuit({ showMessageBox } as never, undefined, summary),
        ).resolves.toBe('discard');
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
