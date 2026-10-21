import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog }));

import { workbenchRootHarness } from './support/workbench-root-harness';

const { authority, server, temporaryDirectory } = workbenchRootHarness(electronMock.dialog);

describe('openTerminalFileLink', () => {
    const identity = {
        device: '2',
        inode: '20',
        root: { path: '/project', device: '1', inode: '10' },
    };
    const bootstrap = (sessions: Array<{ id: string; displayTitle: string }>) => ({
        projects: [{ id: 'project-1', displayTitle: 'Project' }],
        sessions: sessions.map((session) => ({
            ...session,
            archivedAt: undefined,
            workbenchProjectId: 'project-1',
        })),
        selectedSessionId: sessions.at(0)?.id,
    });

    it('hands an authorized directory to the Files explorer instead of opening an editor tab', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    kind: 'directory',
                    identity,
                    path: '/project/.local-config',
                    projectId: 'project-1',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap([{ id: 'session-1', displayTitle: 'Session' }]));
            if (method === 'desktop.openProject') return Promise.resolve({ state: 'requested' });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/project/.local-config',
            }),
        ).resolves.toEqual({ opened: true });
        expect(request).toHaveBeenCalledWith('desktop.openProject', {
            expectedIdentity: identity,
            path: '/project/.local-config',
            sessionId: 'session-1',
            launchIfNeeded: false,
        });
        expect(request).not.toHaveBeenCalledWith('desktop.openFile', expect.anything());
    });

    it('opens an already authorized Home file in the selected Project Session with its location', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity,
                    path: '/project/file.ts',
                    projectId: 'project-1',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap([{ id: 'session-1', displayTitle: 'Session' }]));
            if (method === 'desktop.openFile') return Promise.resolve({ state: 'requested' });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/project/file.ts',
                location: { mode: 'line', startLine: 12, endLine: 14 },
            }),
        ).resolves.toEqual({ opened: true });
        expect(request).toHaveBeenCalledWith('desktop.openFile', {
            expectedIdentity: identity,
            path: '/project/file.ts',
            sessionId: 'session-1',
            launchIfNeeded: false,
            location: { mode: 'line', startLine: 12, endLine: 14 },
            // Clicking a path in Terminal output is a request to go read that file, so the keyboard lands in the
            // editor rather than on the tab button.
            focusEditor: true,
        });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('cancels instead of creating a Session when the linked worktree Project lost its bound Session', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity,
                    path: '/worktree/file.ts',
                    projectId: 'worktree-1',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    ...bootstrap([{ id: 'session-1', displayTitle: 'Session' }]),
                    projects: [
                        { id: 'project-1', displayTitle: 'Project' },
                        { id: 'worktree-1', displayTitle: 'worktree', ownerProjectId: 'project-1' },
                    ],
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/worktree/file.ts',
            }),
        ).resolves.toEqual({ canceled: true, reason: 'worktree_project_unbound' });
        expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
        expect(request).not.toHaveBeenCalledWith('desktop.openFile', expect.anything());
    });

    /**
     * The Project row vanishing between resolve and open used to fall through to `session.create`: the guard read
     * `project?.ownerProjectId !== undefined`, which is `false` for a missing row, so the open continued against a
     * Project id that no longer named anything.
     */
    it('cancels instead of creating a Session when the resolved Project row is gone', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity,
                    path: '/gone/file.ts',
                    projectId: 'project-gone',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap([{ id: 'session-1', displayTitle: 'Session' }]));
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/gone/file.ts',
            }),
        ).resolves.toEqual({ canceled: true, reason: 'project_gone' });
        expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
        expect(request).not.toHaveBeenCalledWith('desktop.openFile', expect.anything());
    });

    it('still creates a Session for an empty top-level Project, which the refusals must not catch', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity,
                    path: '/project/file.ts',
                    projectId: 'project-1',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap([]));
            if (method === 'session.create')
                return Promise.resolve({ session: { id: 'session-new' } });
            if (method === 'desktop.openFile') return Promise.resolve({ state: 'requested' });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '/project/file.ts',
            }),
        ).resolves.toEqual({ opened: true });
        expect(request).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: null,
        });
        expect(request).toHaveBeenCalledWith(
            'desktop.openFile',
            expect.objectContaining({ sessionId: 'session-new' }),
        );
    });

    it('returns ambiguous authorized candidates to the Renderer without opening or prompting', async () => {
        const candidates = [
            {
                path: '/project/packages/a/services/shared/index.ts',
                relativePath: 'packages/a/services/shared/index.ts',
                projectId: 'project-1',
                projectTitle: 'Project',
            },
            {
                path: '/project/packages/b/services/shared/index.ts',
                relativePath: 'packages/b/services/shared/index.ts',
                projectId: 'project-1',
                projectTitle: 'Project',
            },
        ];
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'ambiguous',
                    candidates,
                    sourceSessionId: 'source-session',
                    truncated: false,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '.../services/shared/index.ts',
            }),
        ).resolves.toEqual({ status: 'ambiguous', candidates, truncated: false });
        expect(request.mock.calls.map(([method]) => method)).toEqual(['terminal.fileLink.resolve']);
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('opens an untrusted external file after the user chooses Open', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const externalFile = join(externalRoot, 'notes.ts');
        await writeFile(externalFile, 'export const outside = true;\n');
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const window = { id: 'main-window' };
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'source-session',
                    trusted: false,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request), window });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/notes.ts',
            }),
        ).resolves.toMatchObject({
            opened: true,
            sessionId: 'source-session',
            document: {
                displayPath: externalFile,
                content: 'export const outside = true;\n',
                name: 'notes.ts',
            },
        });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(1);
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            window,
            expect.objectContaining({ buttons: ['Open', 'Trust Folder and Open', 'Cancel'] }),
        );
        expect(request.mock.calls.map(([method]) => method)).toEqual(['terminal.fileLink.resolve']);
    });

    it('trusts the containing folder before opening when the user chooses Trust Folder and Open', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const externalFile = join(externalRoot, 'notes.ts');
        await writeFile(externalFile, 'export const outside = true;\n');
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const calls: string[] = [];
        const request = vi.fn((method: string, parameters?: unknown) => {
            calls.push(method);
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'source-session',
                    trusted: false,
                });
            if (method === 'settings.trustFolder') {
                expect(parameters).toEqual({ path: externalRoot });
                return Promise.resolve(null);
            }
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/notes.ts',
            }),
        ).resolves.toMatchObject({ opened: true });
        expect(calls).toEqual(['terminal.fileLink.resolve', 'settings.trustFolder']);
    });

    it('cancels without reading the file or trusting the folder when the user chooses Cancel', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const externalFile = join(externalRoot, 'notes.ts');
        await writeFile(externalFile, 'export const outside = true;\n');
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'source-session',
                    trusted: false,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/notes.ts',
            }),
        ).resolves.toEqual({ canceled: true });
        expect(request.mock.calls.map(([method]) => method)).toEqual(['terminal.fileLink.resolve']);
    });

    it('refuses an external file in an SSH Host window with a reason instead of reading this Mac', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: '/home/dev/outside/notes.ts',
                    sourceSessionId: 'source-session',
                    trusted: true,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ environment: 'ssh', getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/notes.ts',
            }),
        ).resolves.toEqual({ canceled: true, reason: 'outside_projects' });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(request.mock.calls.map(([method]) => method)).toEqual(['terminal.fileLink.resolve']);
    });

    it('opens a trusted external file without prompting', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const externalFile = join(externalRoot, 'notes.ts');
        await writeFile(externalFile, 'export const outside = true;\n');
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'source-session',
                    trusted: true,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/notes.ts',
            }),
        ).resolves.toMatchObject({
            opened: true,
            sessionId: 'source-session',
            document: { displayPath: externalFile },
        });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('rejects an untrusted external path that is a symlink even after the user chooses Open', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const realFile = join(externalRoot, 'real.ts');
        await writeFile(realFile, 'export const real = true;\n');
        const link = join(externalRoot, 'link.ts');
        await symlink(realFile, link);
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: link,
                    sourceSessionId: 'source-session',
                    trusted: false,
                });
            if (method === 'settings.trustFolder')
                return Promise.reject(new Error('settings.trustFolder should not be called'));
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/link.ts',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('rejects an external path whose file no longer exists', async () => {
        const externalRoot = await temporaryDirectory('caxri-external-');
        const missingFile = join(externalRoot, 'missing.ts');
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: missingFile,
                    sourceSessionId: 'source-session',
                    trusted: true,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/missing.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('uses a native choice when an authorized Project has multiple Sessions', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity,
                    path: '/project/file.ts',
                    projectId: 'project-1',
                    sourceSessionId: 'source-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    ...bootstrap([
                        { id: 'session-1', displayTitle: 'First' },
                        { id: 'session-2', displayTitle: 'Second' },
                    ]),
                    selectedSessionId: undefined,
                });
            if (method === 'desktop.openFile') return Promise.resolve({ state: 'requested' });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/project/file.ts',
            }),
        ).resolves.toEqual({ opened: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Choose a Session' }),
        );
        expect(request).toHaveBeenCalledWith(
            'desktop.openFile',
            expect.objectContaining({ sessionId: 'session-2' }),
        );
    });
});
