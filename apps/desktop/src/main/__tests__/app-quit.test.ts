import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AppQuitOptions, AppQuitStatus } from '../app-quit';
import {
    createAppQuitHandler,
    readAppQuitStatus,
    resolveAppQuit,
    updateRestartPrompt,
} from '../app-quit';

function options(overrides: Partial<AppQuitOptions> = {}): AppQuitOptions {
    return {
        acceptQuit: vi.fn(),
        applyUpdate: vi.fn().mockResolvedValue(false),
        closeDesktop: vi.fn().mockResolvedValue(undefined),
        confirm: vi.fn().mockResolvedValue('keep-running'),
        confirmPendingReviewComments: vi.fn().mockResolvedValue('discard'),
        confirmUpdateRestart: vi.fn().mockResolvedValue('restart'),
        countUnsavedEditorsForRemoteUpdate: vi.fn().mockResolvedValue(0),
        decideUnsavedEditors: vi.fn().mockResolvedValue('continue'),
        detachAll: vi.fn().mockResolvedValue(undefined),
        exit: vi.fn(),
        quitIntent: () => 'user',
        logFailure: vi.fn(),
        notifyStopFailure: vi.fn().mockResolvedValue(undefined),
        persistWindowState: vi.fn().mockResolvedValue(undefined),
        readPendingReviewComments: vi.fn().mockResolvedValue({ count: 0, groups: [] }),
        readStatus: vi
            .fn()
            .mockResolvedValue({ running: { terminals: 0, chats: 0 }, clientCount: 1 }),
        stopServer: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('resolveAppQuit', () => {
    it('cancels before any other prompt when unsaved Editor buffers are kept', async () => {
        const target = options({
            decideUnsavedEditors: vi.fn().mockResolvedValue('cancel'),
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 2, chats: 0 }, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.readPendingReviewComments).not.toHaveBeenCalled();
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.acceptQuit).not.toHaveBeenCalled();
        expect(target.exit).not.toHaveBeenCalled();
    });

    it('continues into the existing quit flow once unsaved buffers are resolved', async () => {
        const target = options({
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 1, chats: 0 }, clientCount: 1 }),
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
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 0, chats: 0 }, clientCount: 2 }),
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
                readStatus: vi
                    .fn()
                    .mockResolvedValue({ running: { terminals: 3, chats: 0 }, clientCount: 4 }),
            });

            await expect(resolveAppQuit(target)).resolves.toBe(outcome);

            expect(target.confirm).toHaveBeenCalledWith({
                running: { terminals: 3, chats: 0 },
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
                readStatus: vi
                    .fn()
                    .mockResolvedValue({ running: { terminals: 2, chats: 0 }, clientCount: 1 }),
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
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.acceptQuit).not.toHaveBeenCalled();
    });

    it('folds pending review comments into the running-task prompt instead of a second dialog', async () => {
        const summary = {
            count: 2,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'caxri',
                    count: 2,
                },
            ],
        };
        const target = options({
            readPendingReviewComments: vi.fn().mockResolvedValue(summary),
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 1, chats: 0 }, clientCount: 1 }),
            confirm: vi.fn().mockResolvedValue('cancel'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.confirmPendingReviewComments).not.toHaveBeenCalled();
        expect(target.confirm).toHaveBeenCalledWith({
            running: { terminals: 1, chats: 0 },
            otherClientCount: 0,
            pendingReviewComments: summary,
        });
    });

    it('still warns about pending review comments when running work cannot be read', async () => {
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
            readStatus: vi.fn().mockRejectedValue(new Error('Server unavailable')),
            confirmPendingReviewComments: vi.fn().mockResolvedValue('cancel'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.confirmPendingReviewComments).toHaveBeenCalledOnce();
        expect(target.confirm).not.toHaveBeenCalled();
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

describe('resolveAppQuit installs a staged update', () => {
    it('installs silently after an ordinary quit that stopped Server Core', async () => {
        const calls: string[] = [];
        const target = options({
            stopServer: () => {
                calls.push('stop');
                return Promise.resolve();
            },
            applyUpdate: (update) => {
                calls.push(`apply:${update.relaunch}`);
                return Promise.resolve(true);
            },
            exit: () => calls.push('exit'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(calls).toEqual(['stop', 'apply:false', 'exit']);
    });

    it('never installs when the quit keeps tasks running, because Server Core still runs from the bundle', async () => {
        const target = options({
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 1, chats: 0 }, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('kept-running');

        expect(target.applyUpdate).not.toHaveBeenCalled();
    });
});

describe('resolveAppQuit for Restart to Update', () => {
    it('restarts without a prompt when nothing would be ended', async () => {
        const target = options({ quitIntent: () => 'update' });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.confirmUpdateRestart).not.toHaveBeenCalled();
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.stopServer).toHaveBeenCalledOnce();
        expect(target.applyUpdate).toHaveBeenCalledWith({ relaunch: true });
        expect(target.exit).toHaveBeenCalledOnce();
    });

    it('asks before ending running work and stops Server Core once the user agrees', async () => {
        const target = options({
            quitIntent: () => 'update',
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 1, chats: 2 }, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.confirmUpdateRestart).toHaveBeenCalledWith({
            running: { terminals: 1, chats: 2 },
            otherClientCount: 0,
        });
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.detachAll).not.toHaveBeenCalled();
        expect(target.applyUpdate).toHaveBeenCalledWith({ relaunch: true });
    });

    it('does nothing when the user cancels the restart', async () => {
        const target = options({
            quitIntent: () => 'update',
            confirmUpdateRestart: vi.fn().mockResolvedValue('cancel'),
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 0, chats: 0 }, clientCount: 2 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.acceptQuit).not.toHaveBeenCalled();
        expect(target.stopServer).not.toHaveBeenCalled();
        expect(target.applyUpdate).not.toHaveBeenCalled();
        expect(target.exit).not.toHaveBeenCalled();
    });

    it('cancels instead of restarting when the confirmation itself fails', async () => {
        const target = options({
            quitIntent: () => 'update',
            confirmUpdateRestart: vi.fn().mockRejectedValue(new Error('dialog failed')),
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 1, chats: 0 }, clientCount: 1 }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.exit).not.toHaveBeenCalled();
    });

    it('keeps unsaved Editor buffers ahead of the restart', async () => {
        const target = options({
            quitIntent: () => 'update',
            decideUnsavedEditors: vi.fn().mockResolvedValue('cancel'),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.stopServer).not.toHaveBeenCalled();
    });

    it('restarts for a phone without prompting, even while work is running', async () => {
        const target = options({
            quitIntent: () => 'remote-update',
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 2, chats: 1 }, clientCount: 2 }),
            readPendingReviewComments: vi.fn().mockResolvedValue({ count: 3, groups: [] }),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('stopped');

        expect(target.decideUnsavedEditors).not.toHaveBeenCalled();
        expect(target.confirmUpdateRestart).not.toHaveBeenCalled();
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.stopServer).toHaveBeenCalledOnce();
        expect(target.applyUpdate).toHaveBeenCalledWith({ relaunch: true });
    });

    it('cancels a phone restart that unsaved Editor buffers would lose', async () => {
        const target = options({
            quitIntent: () => 'remote-update',
            countUnsavedEditorsForRemoteUpdate: vi.fn().mockResolvedValue(2),
        });

        await expect(resolveAppQuit(target)).resolves.toBe('cancelled');

        expect(target.acceptQuit).not.toHaveBeenCalled();
        expect(target.stopServer).not.toHaveBeenCalled();
        expect(target.exit).not.toHaveBeenCalled();
    });

    it('words the prompt around the restart and defaults to Cancel', () => {
        const prompt = updateRestartPrompt({
            running: { terminals: 1, chats: 0 },
            otherClientCount: 1,
        });

        expect(prompt.buttons).toEqual(['Restart and Update', 'Cancel']);
        expect(prompt.defaultId).toBe(1);
        expect(prompt.cancelId).toBe(1);
        expect(prompt.message).toContain('Restart Caxri to update');
        expect(prompt.detail).toContain('disconnect');
    });
});

describe('createAppQuitHandler', () => {
    it('coalesces repeated quit requests and permits another request after cancellation', async () => {
        const status = Promise.withResolvers<AppQuitStatus>();
        const readStatus = vi
            .fn()
            .mockReturnValueOnce(status.promise)
            .mockResolvedValueOnce({ running: { terminals: 1, chats: 0 }, clientCount: 1 });
        const confirm = vi.fn().mockResolvedValue('cancel');
        const requestQuit = createAppQuitHandler(options({ confirm, readStatus }));

        const first = requestQuit();
        const second = requestQuit();
        expect(first).toBe(second);
        // The unsaved-Editor decision is awaited before `readStatus` runs, adding a microtask hop ahead of it; wait
        // for that hop to settle instead of asserting immediately after the call.
        await vi.waitFor(() => expect(readStatus).toHaveBeenCalledOnce());
        status.resolve({ running: { terminals: 1, chats: 0 }, clientCount: 1 });
        await first;

        await requestQuit();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it('accepts a termination signal while the quit prompt is still open instead of waiting on it', async () => {
        const prompt = Promise.withResolvers<'stop'>();
        const target = options({
            confirm: vi.fn().mockReturnValue(prompt.promise),
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 2, chats: 0 }, clientCount: 1 }),
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
            readStatus: vi
                .fn()
                .mockResolvedValue({ running: { terminals: 2, chats: 0 }, clientCount: 1 }),
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

describe('readAppQuitStatus', () => {
    it('reads connected clients and running work by kind together', async () => {
        const request = vi.fn((method: string) =>
            Promise.resolve(
                method === 'host.status'
                    ? { activePtyCount: 3, clientCount: 2 }
                    : { terminals: 1, chats: 2 },
            ),
        );

        await expect(readAppQuitStatus({ request } as never)).resolves.toEqual({
            clientCount: 2,
            running: { terminals: 1, chats: 2 },
        });
        expect(request).toHaveBeenCalledWith('host.status');
        expect(request).toHaveBeenCalledWith('terminal.runningCount');
    });
});
