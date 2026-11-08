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
    it('keeps the common prompt to one line each so macOS 26 centers it, without defaulting to destruction', () => {
        expect(appQuitPrompt({ running: { terminals: 2, chats: 0 }, otherClientCount: 0 })).toEqual(
            {
                buttons: ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'],
                cancelId: 2,
                defaultId: 1,
                detail: 'Running: 2 Terminals',
                message: 'Quit Caxri?',
                title: 'Quit Caxri?',
                type: 'warning',
            },
        );
    });

    it('adds the other-client impact as its own line', () => {
        expect(
            appQuitPrompt({ running: { terminals: 2, chats: 0 }, otherClientCount: 1 }).detail,
        ).toBe('Running: 2 Terminals\n1 other client disconnects if tasks stop.');
    });

    it('adds the pending review comment loss as its own line', () => {
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
        expect(detail).toBe('Running: 1 Terminal\n3 unsent review comments are also lost.');
    });

    it('names running Terminals and Chats separately, like the window-close confirmation', () => {
        expect(
            appQuitPrompt({ running: { terminals: 1, chats: 2 }, otherClientCount: 0 }).detail,
        ).toBe('Running: 1 Terminal and 2 Chats');
        expect(
            appQuitPrompt({ running: { terminals: 0, chats: 1 }, otherClientCount: 0 }).detail,
        ).toBe('Running: 1 Chat');
    });

    it('shows the native prompt without a parent when no window remains', async () => {
        const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
        const impact = { running: { terminals: 1, chats: 0 }, otherClientCount: 0 };

        await expect(confirmAppQuit({ showMessageBox } as never, undefined, impact)).resolves.toBe(
            'keep-running',
        );
        expect(showMessageBox).toHaveBeenCalledWith(appQuitPrompt(impact));
    });

    it('states the pending review comment count without defaulting to discarding them', () => {
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
            detail: 'They are kept in memory only.',
            message: 'Lose 3 review comments?',
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
            detail: 'Reopen Caxri to stop them.',
            message: 'Some tasks may still be running.',
            title: "Caxri Couldn't Stop All Tasks",
            type: 'error',
        });
    });
});
