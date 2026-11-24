import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    clipboard: { writeText: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() },
}));
vi.mock('electron', () => electronMock);

import { workbenchRootHarness } from './support/workbench-root-harness';

const { authority, server } = workbenchRootHarness(electronMock.dialog);

describe('revealTerminalFileLink', () => {
    it.each([
        {
            status: 'external',
            path: '/outside/notes.ts',
            sourceSessionId: 'source-session',
            trusted: false,
        },
        {
            status: 'authorized',
            kind: 'file',
            identity: {
                device: '2',
                inode: '20',
                root: { path: '/project', device: '1', inode: '10' },
            },
            path: '/project/file.ts',
            projectId: 'project-1',
            sourceSessionId: 'source-session',
        },
    ])('reveals a $status link in Finder without prompting', async (resolution) => {
        electronMock.dialog.showMessageBox.mockClear();
        const request = vi.fn((method: string) =>
            method === 'terminal.fileLink.resolve'
                ? Promise.resolve(resolution)
                : Promise.reject(new Error(`Unexpected method: ${method}`)),
        );
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.revealTerminalFileLink({
                terminalId: 'terminal-1',
                target: 'notes.ts',
                action: 'reveal',
            }),
        ).resolves.toEqual({ revealed: true });
        expect(electronMock.shell.showItemInFolder).toHaveBeenLastCalledWith(resolution.path);
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('returns ambiguous candidates instead of revealing one of them', async () => {
        electronMock.shell.showItemInFolder.mockClear();
        const ambiguous = {
            status: 'ambiguous',
            candidates: [
                { path: '/a/x.ts', relativePath: 'x.ts', projectId: 'a', projectTitle: 'A' },
                { path: '/b/x.ts', relativePath: 'x.ts', projectId: 'b', projectTitle: 'B' },
            ],
            truncated: false,
            sourceSessionId: 'source-session',
        };
        const request = vi.fn(() => Promise.resolve(ambiguous));
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.revealTerminalFileLink({
                terminalId: 'terminal-1',
                target: 'x.ts',
                action: 'reveal',
            }),
        ).resolves.toEqual({
            status: 'ambiguous',
            candidates: ambiguous.candidates,
            truncated: false,
        });
        expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
    });

    it('opens an HTML page outside every Project in the browser without prompting', async () => {
        electronMock.dialog.showMessageBox.mockClear();
        const request = vi.fn(() =>
            Promise.resolve({
                status: 'external',
                path: '/reports/daily.html',
                sourceSessionId: 'source-session',
                trusted: false,
            }),
        );
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.revealTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/reports/daily.html',
                action: 'openInBrowser',
            }),
        ).resolves.toEqual({ revealed: true });
        expect(electronMock.shell.openPath).toHaveBeenLastCalledWith('/reports/daily.html');
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('refuses to hand a file that is not an HTML page to its default application', async () => {
        electronMock.shell.openPath.mockClear();
        const request = vi.fn(() =>
            Promise.resolve({
                status: 'external',
                path: '/downloads/run.command',
                sourceSessionId: 'source-session',
                trusted: true,
            }),
        );
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.revealTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/downloads/run.command',
                action: 'openInBrowser',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(electronMock.shell.openPath).not.toHaveBeenCalled();
    });
});
