import { describe, expect, it, vi } from 'vitest';

import {
    appQuitPrompt,
    confirmAppQuit,
    confirmPendingReviewCommentsQuit,
    createAppQuitPromptOptions,
    notifyAppQuitStopFailure,
    pendingReviewCommentsPrompt,
} from '../app-quit';

/**
 * The native quit prompts' wording, defaults, and window parenting. The quit decision flow that chooses between them
 * lives in `app-quit.test.ts`.
 */
describe('appQuitPrompt', () => {
    it('explains session portability and other-client impact without defaulting to destruction', () => {
        expect(appQuitPrompt({ running: { terminals: 2, chats: 0 }, otherClientCount: 1 })).toEqual(
            {
                buttons: ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'],
                cancelId: 2,
                defaultId: 1,
                detail: 'Quit and Stop Tasks ends every running Terminal and Agent process, releases Agent conversations so they can be resumed in other tools, and stops Caxri Server. Quit and Keep Tasks Running leaves them attached to Caxri in the background.\n\n1 other client is connected to Caxri Server. Stopping will disconnect it.',
                message: 'Quit Caxri while 2 Terminals are running?',
                title: 'Quit Caxri?',
                type: 'warning',
            },
        );
    });

    it('adds the pending review comment loss as its own paragraph', () => {
        const detail = appQuitPrompt({
            running: { terminals: 1, chats: 0 },
            otherClientCount: 0,
            pendingReviewComments: {
                count: 3,
                groups: [
                    {
                        sessionId: 'session-1',
                        repositoryId: 'repo-1',
                        repositoryName: 'caxri',
                        count: 3,
                    },
                ],
            },
        }).detail;
        expect(detail).toMatch(
            /\n\nQuitting also loses 3 unsent review comments, because review comments live in memory only\.$/,
        );
    });

    it('names running Terminals and Chats separately, like the window-close confirmation', () => {
        expect(
            appQuitPrompt({ running: { terminals: 1, chats: 2 }, otherClientCount: 0 }).message,
        ).toBe('Quit Caxri while 1 Terminal and 2 Chats are running?');
        expect(
            appQuitPrompt({ running: { terminals: 0, chats: 1 }, otherClientCount: 0 }).message,
        ).toBe('Quit Caxri while 1 Chat is running?');
    });

    it('shows the native prompt without a parent when no window remains', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
        const impact = { running: { terminals: 1, chats: 0 }, otherClientCount: 0 };

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
        const impact = { running: { terminals: 1, chats: 0 }, otherClientCount: 0 };
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
            detail: 'Caxri will quit now. Reopen Caxri to stop any remaining tasks before resuming their Agent conversations in another tool.',
            message: 'Some background tasks may still be running.',
            title: "Caxri Couldn't Stop All Tasks",
            type: 'error',
        });
    });
});
