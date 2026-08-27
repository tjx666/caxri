import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog }));

import { ProjectRootGrants } from '../root-grants';
import type { DesktopServerConnection } from '../server-connection';
import { createWorkbenchRootAuthority } from '../workbench-root-authority';

const temporaryDirectories: string[] = [];

/**
 * Returns the realpath-canonicalized directory so assertions can compare it directly against the canonical paths
 * `workbench-root-authority` produces; on macOS `tmpdir()` itself is a symlink (`/var` -> `/private/var`), so the raw
 * `mkdtemp` result would never match.
 */
async function temporaryDirectory(prefix = 'caxri-workbench-root-'): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return realpath(path);
}

afterEach(async () => {
    electronMock.dialog.showMessageBox.mockReset();
    electronMock.dialog.showOpenDialog.mockReset();
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

function server(request: (method: string, parameters?: unknown) => Promise<unknown>) {
    return { request } as unknown as DesktopServerConnection;
}

const unusedServer = server(() =>
    Promise.reject(new Error('Server was not expected to be called')),
);

function authority(options: {
    getServer?: DesktopServerConnection;
    grants?: ProjectRootGrants;
    nextTestRoot?: () => string | undefined;
    window?: object;
}) {
    const grants = options.grants ?? new ProjectRootGrants();
    return {
        grants,
        instance: createWorkbenchRootAuthority({
            getServer: () => options.getServer ?? unusedServer,
            getWindow: () => options.window as never,
            grants,
            nextTestRoot: options.nextTestRoot ?? (() => {}),
        }),
    };
}

describe('selectProjectDirectory', () => {
    it('grants a single-use root from the injected test root without opening a dialog', async () => {
        const grants = new ProjectRootGrants();
        const { instance } = authority({ grants, nextTestRoot: () => '/test/root' });

        await expect(instance.selectProjectDirectory()).resolves.toBe('/test/root');
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
        await expect(grants.use('/test/root', () => Promise.resolve('created'))).resolves.toBe(
            'created',
        );
    });

    it('grants the chosen directory and passes the window to the native dialog', async () => {
        const grants = new ProjectRootGrants();
        const window = { id: 'main-window' };
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/chosen/root'],
        });
        const { instance } = authority({ grants, window });

        await expect(instance.selectProjectDirectory()).resolves.toBe('/chosen/root');
        expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(
            window,
            expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
        );
        await expect(grants.use('/chosen/root', () => Promise.resolve('created'))).resolves.toBe(
            'created',
        );
    });

    it('resolves to null and grants nothing when the dialog is dismissed', async () => {
        const grants = new ProjectRootGrants();
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: true,
            filePaths: [],
        });
        const { instance } = authority({ grants });

        await expect(instance.selectProjectDirectory()).resolves.toBeNull();
        await expect(grants.use('/chosen/root', () => Promise.resolve('created'))).rejects.toThrow(
            'was not selected',
        );
    });

    it('calls the dialog without a window argument when no window is available', async () => {
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: true,
            filePaths: [],
        });
        const { instance } = authority({});

        await instance.selectProjectDirectory();
        expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(
            expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
        );
    });
});

describe('createProject / cancelProjectCreate orchestration', () => {
    it('consumes the matching grant and forwards to the Server', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        const request = vi.fn(() => Promise.resolve({ id: 'project-1' }));
        const { instance } = authority({ getServer: server(request), grants });

        await expect(instance.createProject({ rootPath: '/project' })).resolves.toEqual({
            id: 'project-1',
        });
        expect(request).toHaveBeenCalledWith('project.create', { rootPath: '/project' });
        /**
         * The grant is single-use: a second creation attempt for the same root must be denied even though the first one
         * succeeded.
         */
        await expect(instance.createProject({ rootPath: '/project' })).rejects.toThrow(
            'was not selected',
        );
    });

    it('rejects Project creation for a root the Renderer never had authorized', async () => {
        const request = vi.fn(() => Promise.resolve({ id: 'project-1' }));
        const { instance } = authority({ getServer: server(request) });

        await expect(instance.createProject({ rootPath: '/untrusted' })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('revokes the grant on explicit cancellation so a later create is denied', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        const { instance } = authority({ grants });

        expect(instance.cancelProjectCreate({ rootPath: '/project' })).toBeNull();
        await expect(instance.createProject({ rootPath: '/project' })).rejects.toThrow(
            'was not selected',
        );
    });
});

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
                location: { line: 12, column: 4 },
            }),
        ).resolves.toEqual({ opened: true });
        expect(request).toHaveBeenCalledWith('desktop.openFile', {
            expectedIdentity: identity,
            path: '/project/file.ts',
            sessionId: 'session-1',
            launchIfNeeded: false,
            location: { line: 12, column: 4 },
        });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('binds an outside file to the selected root before adding its Project and creating a Session', async () => {
        const selectedRoot = await temporaryDirectory();
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve(
                    'selectedRoot' in (parameters as object)
                        ? {
                              status: 'selection_authorized',
                              identity: {
                                  ...identity,
                                  root: { ...identity.root, path: selectedRoot },
                              },
                              path: `${selectedRoot}/file.ts`,
                              rootPath: selectedRoot,
                              sourceSessionId: 'source-session',
                          }
                        : {
                              status: 'authorization_required',
                              path: `${selectedRoot}/file.ts`,
                              sourceSessionId: 'source-session',
                          },
                );
            if (method === 'project.create') return Promise.resolve({ id: 'project-1' });
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap([]));
            if (method === 'session.create')
                return Promise.resolve({ session: { id: 'session-created' } });
            if (method === 'desktop.openFile') return Promise.resolve({ state: 'requested' });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({
            getServer: server(request),
            nextTestRoot: () => selectedRoot,
        });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/selected/file.ts',
            }),
        ).resolves.toEqual({ opened: true });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
            'terminal.fileLink.resolve',
            'terminal.fileLink.resolve',
            'project.create',
            'app.bootstrap',
            'session.create',
            'desktop.openFile',
        ]);
        expect(request).toHaveBeenCalledWith('project.create', {
            rootPath: selectedRoot,
            expectedRootIdentity: {
                path: selectedRoot,
                device: identity.root.device,
                inode: identity.root.inode,
            },
        });
        expect(request).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: null,
        });
        expect(request).toHaveBeenCalledWith(
            'desktop.openFile',
            expect.objectContaining({
                expectedIdentity: {
                    ...identity,
                    root: { ...identity.root, path: selectedRoot },
                },
            }),
        );
    });

    it('cancels before directory selection without creating Project or Session state', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorization_required',
                    path: '/outside/file.ts',
                    sourceSessionId: 'source-session',
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/outside/file.ts',
            }),
        ).resolves.toEqual({ canceled: true });
        expect(request.mock.calls.map(([method]) => method)).toEqual(['terminal.fileLink.resolve']);
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('revokes the selected-root grant when Project creation fails', async () => {
        const selectedRoot = await temporaryDirectory();
        const grants = new ProjectRootGrants();
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve(
                    'selectedRoot' in (parameters as object)
                        ? {
                              status: 'selection_authorized',
                              identity: {
                                  ...identity,
                                  root: { ...identity.root, path: selectedRoot },
                              },
                              path: `${selectedRoot}/file.ts`,
                              rootPath: selectedRoot,
                              sourceSessionId: 'source-session',
                          }
                        : {
                              status: 'authorization_required',
                              path: `${selectedRoot}/file.ts`,
                              sourceSessionId: 'source-session',
                          },
                );
            if (method === 'project.create')
                return Promise.reject(new Error('Runtime unavailable'));
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({
            getServer: server(request),
            grants,
            nextTestRoot: () => selectedRoot,
        });

        await expect(
            instance.openTerminalFileLink({
                terminalId: 'terminal-1',
                target: '~/selected/file.ts',
            }),
        ).rejects.toThrow('Runtime unavailable');
        await expect(grants.use(selectedRoot, () => Promise.resolve('retried'))).rejects.toThrow(
            'was not selected',
        );
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

describe('authorizeSelection', () => {
    it('canonicalizes the selected path, grants it, and forwards the realpath to the Server', async () => {
        const projectRoot = await temporaryDirectory();
        const request = vi.fn(() => Promise.resolve({ id: 'session-1' }));
        const { instance } = authority({
            getServer: server(request),
            nextTestRoot: () => projectRoot,
        });

        const result = await instance.authorizeSelection({ sessionId: 'session-1' });
        expect(result).toEqual({ id: 'session-1' });
        expect(request).toHaveBeenCalledWith('session.workbenchRoot.authorizeSelection', {
            sessionId: 'session-1',
            rootPath: projectRoot,
        });
    });

    it('returns canceled without granting when the dialog is dismissed', async () => {
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: true,
            filePaths: [],
        });
        const request = vi.fn(() => Promise.resolve({ id: 'session-1' }));
        const { instance } = authority({ getServer: server(request) });

        await expect(instance.authorizeSelection({ sessionId: 'session-1' })).resolves.toEqual({
            canceled: true,
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('revokes the grant when the Server rejects authorization, closing the retry window', async () => {
        const projectRoot = await temporaryDirectory();
        const grants = new ProjectRootGrants();
        const request = vi.fn(() => Promise.reject(new Error('Runtime unavailable')));
        const { instance } = authority({
            getServer: server(request),
            grants,
            nextTestRoot: () => projectRoot,
        });

        await expect(instance.authorizeSelection({ sessionId: 'session-1' })).rejects.toThrow(
            'Runtime unavailable',
        );
        /**
         * ProjectRootGrants#use restores the grant on failure by itself, but authorizeSelection explicitly revokes it
         * again afterward so a failed authorization cannot be silently retried.
         */
        await expect(grants.use(projectRoot, () => Promise.resolve('retried'))).rejects.toThrow(
            'was not selected',
        );
    });
});

describe('continueInWorktree', () => {
    it('resolves an already-linked candidate directly through the Project and always cancels the candidate', async () => {
        const calls: Array<[string, unknown]> = [];
        const request = vi.fn((method: string, parameters?: unknown) => {
            calls.push([method, parameters]);
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({
                    candidateId: 'candidate-1',
                    rootPath: '/worktree',
                    projectId: 'project-1',
                });
            if (method === 'session.selectWorkbenchRoot')
                return Promise.resolve({ id: 'session-1' });
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(calls.map(([method]) => method)).toEqual([
            'session.workbenchCandidate.claim',
            'session.selectWorkbenchRoot',
            'session.workbenchCandidate.cancel',
        ]);
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('authorizes a fresh worktree once the selected path canonicalizes to the detected root', async () => {
        const worktreeRoot = await temporaryDirectory();
        const linkDirectory = await temporaryDirectory('caxri-workbench-root-link-');
        const link = join(linkDirectory, 'alias');
        await symlink(worktreeRoot, link);

        const grants = new ProjectRootGrants();
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({ candidateId: 'candidate-1', rootPath: worktreeRoot });
            if (method === 'session.workbenchCandidate.authorize')
                return Promise.resolve({ id: 'session-1' });
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({
            getServer: server(request),
            grants,
            nextTestRoot: () => link,
        });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(request).toHaveBeenCalledWith('session.workbenchCandidate.authorize', {
            candidateId: 'candidate-1',
            rootPath: worktreeRoot,
            sessionId: 'session-1',
        });
        expect(request).toHaveBeenCalledWith('session.workbenchCandidate.cancel', {
            candidateId: 'candidate-1',
            sessionId: 'session-1',
        });
    });

    it('denies a selection whose canonical path does not match the detected worktree', async () => {
        const worktreeRoot = await temporaryDirectory();
        const otherRoot = await temporaryDirectory();
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({ candidateId: 'candidate-1', rootPath: worktreeRoot });
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({
            getServer: server(request),
            nextTestRoot: () => otherRoot,
        });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(request).toHaveBeenCalledWith('session.workbenchCandidate.cancel', {
            candidateId: 'candidate-1',
            sessionId: 'session-1',
        });
    });

    it('returns canceled without authorizing when the worktree dialog is dismissed', async () => {
        const worktreeRoot = await temporaryDirectory();
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: true,
            filePaths: [],
        });
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({ candidateId: 'candidate-1', rootPath: worktreeRoot });
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ canceled: true });
        expect(request).toHaveBeenCalledWith('session.workbenchCandidate.cancel', {
            candidateId: 'candidate-1',
            sessionId: 'session-1',
        });
    });

    it('revokes the grant when authorization fails and still cancels the candidate', async () => {
        const worktreeRoot = await temporaryDirectory();
        const grants = new ProjectRootGrants();
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({ candidateId: 'candidate-1', rootPath: worktreeRoot });
            if (method === 'session.workbenchCandidate.authorize')
                return Promise.reject(new Error('Runtime unavailable'));
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({
            getServer: server(request),
            grants,
            nextTestRoot: () => worktreeRoot,
        });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).rejects.toThrow('Runtime unavailable');
        await expect(grants.use(worktreeRoot, () => Promise.resolve('retried'))).rejects.toThrow(
            'was not selected',
        );
        expect(request).toHaveBeenCalledWith('session.workbenchCandidate.cancel', {
            candidateId: 'candidate-1',
            sessionId: 'session-1',
        });
    });

    it('does not let a failed best-effort cancel mask the original outcome', async () => {
        const worktreeRoot = await temporaryDirectory();
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({
                    candidateId: 'candidate-1',
                    rootPath: worktreeRoot,
                    projectId: 'project-1',
                });
            if (method === 'session.selectWorkbenchRoot')
                return Promise.resolve({ id: 'session-1' });
            if (method === 'session.workbenchCandidate.cancel')
                return Promise.reject(new Error('cancel transport failure'));
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ id: 'session-1' });
    });
});
