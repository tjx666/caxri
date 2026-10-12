import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToastKind, ToastOptions } from '../../../stores/toasts';

const mocks = vi.hoisted(() => {
    const pushToast = vi.fn<(kind: ToastKind, message: string, options?: ToastOptions) => void>();
    return {
        caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
        getSelectedSession: vi.fn(),
        pushToast,
        refreshWorkbench: vi.fn(() => Promise.resolve()),
        /**
         * Mirrors the real funnel's swallow-and-report contract rather than only forwarding `run`: an action offered
         * inside a toast must survive its own request failing, which is unobservable when the double re-throws.
         */
        tryCommand: vi.fn(
            async (
                ...[label, run]: [
                    string,
                    () => Promise<unknown>,
                    { refresh?: () => Promise<void> }?,
                ]
            ): Promise<unknown> => {
                try {
                    return await run();
                } catch (error) {
                    pushToast('error', `${label}: ${(error as Error).message}`);
                    return undefined;
                }
            },
        ),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../stores/dialogs', () => ({
    useDialogStore: { getState: vi.fn(() => ({ setArchivedSessionsOpen: vi.fn() })) },
}));
vi.mock('../../../stores/selectors', () => ({ getSelectedSession: mocks.getSelectedSession }));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: mocks.refreshWorkbench }));

import {
    archiveSelectedSession,
    archiveSession,
    unarchiveSession,
    unarchiveSessions,
} from '../session-archive-commands';

describe('Session archive and restore notices', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.getSelectedSession.mockReset();
        mocks.pushToast.mockClear();
        mocks.refreshWorkbench.mockClear();
        mocks.tryCommand.mockClear();
    });

    it('records an archive as an undoable info notice naming the Session', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.archive', {
            sessionId: 'session-1',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toEqual({ refresh: mocks.refreshWorkbench });
        expect(mocks.pushToast).toHaveBeenCalledOnce();
        const [kind, message, options] = mocks.pushToast.mock.calls[0] ?? [];
        expect(kind).toBe('info');
        expect(message).toBe('Archived "api-fix"');
        expect(options?.action).toEqual({
            id: 'session.unarchive',
            params: { sessionId: 'session-1' },
            // A screen reader browsing the history by button hears only labels, so each Undo names its Session.
            accessibleLabel: 'Undo archiving api-fix',
        });
        // Archiving is reversible, so the notice takes the ordinary four-second expiry.
        expect(options?.persist).toBeUndefined();
    });

    /**
     * Undo asks for `unchanged` rather than the default `top` an explicit restore uses: it reverses one archive, so the
     * row has to come back where it was instead of jumping over an order the user arranged by dragging.
     */
    it('restores the archived Session in place when the notice Undo action is used', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        // What the notification center replays for `session.unarchive`.
        unarchiveSession('session-1', 'unchanged');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('session.unarchive', {
            placement: 'unchanged',
            sessionId: 'session-1',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toEqual({ refresh: mocks.refreshWorkbench });
    });

    it('reports a stale Undo as an error instead of throwing out of the notice', async () => {
        // The Session was deleted, or the window navigated away, after the notice was raised.
        mocks.caxriRequest.mockRejectedValueOnce(new Error('Session not found'));

        expect(() => unarchiveSession('session-1', 'unchanged')).not.toThrow();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).toHaveBeenLastCalledWith(
            'error',
            'Session restore failed: Session not found',
        );
    });

    it('stays silent when the archive request itself fails', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('Server is not ready'));

        archiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).toHaveBeenCalledExactlyOnceWith(
            'error',
            'Session archive failed: Server is not ready',
        );
    });

    it('archives the selected Session through the same notice path', async () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-2' });
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-2', displayTitle: 'docs' });

        archiveSelectedSession();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.archive', {
            sessionId: 'session-2',
        });
        expect(mocks.pushToast).toHaveBeenCalledWith('info', 'Archived "docs"', expect.anything());
    });

    it('records an explicit restore as a named notice, the way an archive is recorded', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        unarchiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.unarchive', {
            placement: 'top',
            sessionId: 'session-1',
        });
        expect(mocks.tryCommand.mock.calls[0]?.[2]).toEqual({ refresh: mocks.refreshWorkbench });
        expect(mocks.pushToast).toHaveBeenCalledExactlyOnceWith('info', 'Restored "api-fix"');
    });

    it('leaves the archive notice Undo silent, since that notice already named the Session', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ id: 'session-1', displayTitle: 'api-fix' });

        unarchiveSession('session-1', 'unchanged');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).not.toHaveBeenCalled();
    });

    it('stays silent when the restore request itself fails', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('Server is not ready'));

        unarchiveSession('session-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).toHaveBeenCalledExactlyOnceWith(
            'error',
            'Session restore failed: Server is not ready',
        );
    });

    it('counts a batch restore and reports what the Server actually restored', async () => {
        mocks.caxriRequest.mockResolvedValueOnce([
            { id: 'session-1', displayTitle: 'api-fix' },
            { id: 'session-2', displayTitle: 'docs' },
        ]);

        unarchiveSessions(['session-1', 'session-2', 'session-3']);
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.unarchiveMany', {
            placement: 'top',
            sessionIds: ['session-1', 'session-2', 'session-3'],
        });
        expect(mocks.pushToast).toHaveBeenCalledExactlyOnceWith('info', 'Restored 2 Sessions');
    });
});
