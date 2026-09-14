import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createTerminal: vi.fn(() => Promise.resolve()),
    request: vi.fn(() => Promise.resolve(null)),
    selectedSession: vi.fn<() => { id: string } | undefined>(() => ({ id: 'session-a' })),
}));
vi.mock('./caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../stores/selectors', () => ({ getSelectedSession: mocks.selectedSession }));
vi.mock('../features/terminal/terminal-commands', () => ({
    createTerminal: mocks.createTerminal,
}));

import { dismissToast, getToasts } from '../stores/toasts';
import { openFileInTerminal, openFileWithDefaultApp, revealFile } from './desktop-file-actions';

afterEach(() => {
    mocks.createTerminal.mockClear();
    mocks.request.mockClear();
    mocks.selectedSession.mockReturnValue({ id: 'session-a' });
    dismissToast();
});

describe('desktop file actions', () => {
    it('scopes both native launches to the selected Session', async () => {
        await revealFile('/project/page.html');
        expect(mocks.request).toHaveBeenLastCalledWith('files.reveal', {
            sessionId: 'session-a',
            path: '/project/page.html',
        });

        await openFileWithDefaultApp('/project/page.html');
        expect(mocks.request).toHaveBeenLastCalledWith('files.openWithDefaultApp', {
            sessionId: 'session-a',
            path: '/project/page.html',
        });
    });

    it('reports a refused default-application launch as an error toast', async () => {
        mocks.request.mockRejectedValueOnce(new Error('No application is registered'));

        await openFileWithDefaultApp('/project/unknown.xyz');

        expect(getToasts().at(-1)?.type).toBe('error');
    });

    it('never reaches the Server without a selected Session', async () => {
        mocks.selectedSession.mockReturnValue(undefined);

        await openFileWithDefaultApp('/project/page.html');

        expect(mocks.request).not.toHaveBeenCalled();
        expect(getToasts().at(-1)?.type).toBe('error');
    });

    it('opens a Terminal in the requested directory', async () => {
        await openFileInTerminal('/project/src');

        expect(mocks.createTerminal).toHaveBeenCalledWith('shell', { cwd: '/project/src' });
    });
});
