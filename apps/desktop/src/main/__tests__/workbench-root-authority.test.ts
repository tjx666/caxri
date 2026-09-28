import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog }));

import { ProjectRootGrants } from '../root-grants';
import { workbenchRootHarness } from './support/workbench-root-harness';

const { authority, server, temporaryDirectory } = workbenchRootHarness(electronMock.dialog);

describe('selectProjectFolder', () => {
    it('grants a single-use root from the injected test root without opening a dialog', async () => {
        const grants = new ProjectRootGrants();
        const { instance } = authority({ grants, nextTestRoot: () => '/test/root' });

        await expect(instance.selectProjectFolder()).resolves.toBe('/test/root');
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
        await expect(grants.use('/test/root', () => Promise.resolve('created'))).resolves.toBe(
            'created',
        );
    });

    it('grants the chosen folder and passes the window to the native dialog', async () => {
        const grants = new ProjectRootGrants();
        const window = { id: 'main-window' };
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/chosen/root'],
        });
        const { instance } = authority({ grants, window });

        await expect(instance.selectProjectFolder()).resolves.toBe('/chosen/root');
        expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(
            window,
            expect.objectContaining({
                title: 'Choose a Project folder',
                properties: ['openDirectory', 'createDirectory'],
            }),
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

        await expect(instance.selectProjectFolder()).resolves.toBeNull();
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

        await instance.selectProjectFolder();
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

describe('pathBrowser', () => {
    it('returns an external document without creating a Project or Session', async () => {
        const projectRoot = await temporaryDirectory('caxri-path-project-');
        const externalRoot = await temporaryDirectory('caxri-path-external-');
        const externalFile = `${externalRoot}/external.ts`;
        await writeFile(externalFile, 'export const external = true;\n');
        const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>();
        request.mockImplementation((method) => {
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [{ id: 'project-1', displayTitle: 'Project', rootPath: projectRoot }],
                    sessions: [
                        {
                            id: 'session-1',
                            archivedAt: undefined,
                            projectId: 'project-1',
                            workbenchProjectId: 'project-1',
                        },
                    ],
                    selectedSessionId: 'session-1',
                });
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });
        const initial = await instance.pathBrowser.start({ sessionId: 'session-1' });
        const listed = await instance.pathBrowser.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${externalRoot}/external`,
        });
        const file = listed.entries.find((entry) => entry.name === 'external.ts');

        await expect(
            instance.pathBrowser.open({ browserId: initial.browserId, entryId: file!.id }),
        ).resolves.toMatchObject({
            opened: true,
            kind: 'external',
            document: {
                displayPath: externalFile,
                content: 'export const external = true;\n',
                readOnly: true,
            },
        });
        expect(request).not.toHaveBeenCalledWith('project.create', expect.anything());
        expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
        expect(request).not.toHaveBeenCalledWith('desktop.openFile', expect.anything());
    });
});

describe('authorizeSelection', () => {
    it('canonicalizes the selected path, grants it, and forwards the realpath to the Server', async () => {
        const projectRoot = await temporaryDirectory();
        const request = vi.fn((method: string) =>
            Promise.resolve(
                method === 'session.workbenchRoot.resolve' ? projectRoot : { id: 'session-1' },
            ),
        );
        const { instance } = authority({
            getServer: server(request),
            nextTestRoot: () => projectRoot,
        });

        const result = await instance.authorizeSelection({
            sessionId: 'session-1',
            worktreeId: 'worktree-1',
        });
        expect(result).toEqual({ id: 'session-1' });
        expect(request).toHaveBeenCalledWith('session.workbenchRoot.authorizeSelection', {
            sessionId: 'session-1',
            rootPath: projectRoot,
            worktreeId: 'worktree-1',
        });
    });

    it('rejects stale discovery without opening a native picker or forwarding authorization', async () => {
        const request = vi.fn(() => Promise.reject(new Error('Worktree unavailable')));
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.authorizeSelection({ sessionId: 'session-1', worktreeId: 'stale' }),
        ).rejects.toThrow('Worktree unavailable');
        expect(request).toHaveBeenCalledExactlyOnceWith('session.workbenchRoot.resolve', {
            sessionId: 'session-1',
            worktreeId: 'stale',
        });
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('revokes the grant when the Server rejects authorization, closing the retry window', async () => {
        const projectRoot = await temporaryDirectory();
        const grants = new ProjectRootGrants();
        const request = vi.fn((method: string) =>
            method === 'session.workbenchRoot.resolve'
                ? Promise.resolve(projectRoot)
                : Promise.reject(new Error('Runtime unavailable')),
        );
        const { instance } = authority({
            getServer: server(request),
            grants,
            nextTestRoot: () => projectRoot,
        });

        await expect(
            instance.authorizeSelection({ sessionId: 'session-1', worktreeId: 'worktree-1' }),
        ).rejects.toThrow('Runtime unavailable');
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

    it('authorizes the claimed worktree directly without asking the user to select it again', async () => {
        const worktreeRoot = await temporaryDirectory();
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
        });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
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

    it('ignores unrelated picker input and only authorizes the claimed worktree', async () => {
        const worktreeRoot = await temporaryDirectory();
        const otherRoot = await temporaryDirectory();
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
            nextTestRoot: () => otherRoot,
        });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
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

    it('does not authorize a disappeared worktree and still cancels its candidate', async () => {
        const worktreeRoot = join(await temporaryDirectory(), 'missing');
        const request = vi.fn((method: string) => {
            if (method === 'session.workbenchCandidate.claim')
                return Promise.resolve({ candidateId: 'candidate-1', rootPath: worktreeRoot });
            if (method === 'session.workbenchCandidate.cancel') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.continueInWorktree({ candidateId: 'candidate-1', sessionId: 'session-1' }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: 'The worktree candidate is no longer available',
        });
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
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

describe('openCommanderFileLink', () => {
    it('answers an ambiguous resolution without raising the Workbench', async () => {
        const focusWindow = vi.fn(() => Promise.resolve());
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'ambiguous',
                    candidates: [
                        {
                            path: '/a/notes.md',
                            relativePath: 'notes.md',
                            projectId: 'project-a',
                            projectTitle: 'A',
                        },
                    ],
                    truncated: false,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request), focusWindow });

        await expect(
            instance.openCommanderFileLink({ terminalId: 'commander', target: 'notes.md' }),
        ).resolves.toMatchObject({ status: 'ambiguous', truncated: false });
        expect(focusWindow).not.toHaveBeenCalled();
    });

    it("opens an external file under a real, visible Session instead of the Commander's own hidden one", async () => {
        const externalRoot = await temporaryDirectory('caxri-commander-external-');
        const externalFile = join(externalRoot, 'notes.md');
        await writeFile(externalFile, 'hello\n');
        const focusWindow = vi.fn(() => Promise.resolve());
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'commander-hidden-session',
                    trusted: true,
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [],
                    sessions: [
                        {
                            id: 'workbench-session',
                            archivedAt: undefined,
                            workbenchProjectId: 'project-1',
                        },
                    ],
                    selectedSessionId: 'workbench-session',
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request), focusWindow });

        await expect(
            instance.openCommanderFileLink({ terminalId: 'commander', target: externalFile }),
        ).resolves.toMatchObject({ opened: true, sessionId: 'workbench-session' });
        expect(focusWindow).toHaveBeenCalledTimes(1);
    });

    it('cancels an untrusted external open without picking a Session', async () => {
        const externalFile = '/outside/notes.md';
        const focusWindow = vi.fn(() => Promise.resolve());
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'external',
                    path: externalFile,
                    sourceSessionId: 'commander-hidden-session',
                    trusted: false,
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [],
                    sessions: [],
                    selectedSessionId: undefined,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request), focusWindow });

        await expect(
            instance.openCommanderFileLink({ terminalId: 'commander', target: externalFile }),
        ).resolves.toEqual({ canceled: true });
        expect(focusWindow).toHaveBeenCalledTimes(1);
    });

    it('prefers the Session the Commander itself created when the resolved Project has more than one', async () => {
        const focusWindow = vi.fn(() => Promise.resolve());
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity: { rootPath: '/project', revision: 0 },
                    path: '/project/notes.md',
                    projectId: 'project-1',
                    sourceSessionId: 'commander-hidden-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [{ id: 'project-1', displayTitle: 'Project', rootPath: '/project' }],
                    sessions: [
                        { id: 'session-a', archivedAt: undefined, workbenchProjectId: 'project-1' },
                        { id: 'session-b', archivedAt: undefined, workbenchProjectId: 'project-1' },
                    ],
                    selectedSessionId: 'session-a',
                });
            if (method === 'commander.board')
                return Promise.resolve({
                    rows: [{ sessionId: 'session-b', commanderSession: true }],
                });
            if (method === 'desktop.openFile') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request), focusWindow });

        await expect(
            instance.openCommanderFileLink({ terminalId: 'commander', target: 'notes.md' }),
        ).resolves.toEqual({ opened: true });
        expect(request).toHaveBeenCalledWith(
            'desktop.openFile',
            expect.objectContaining({ sessionId: 'session-b' }),
        );
    });

    it('refuses a worktree Project no Session is using as its Workbench Root', async () => {
        const request = vi.fn((method: string) => {
            if (method === 'terminal.fileLink.resolve')
                return Promise.resolve({
                    status: 'authorized',
                    identity: { rootPath: '/wt', revision: 0 },
                    path: '/wt/notes.md',
                    projectId: 'worktree-project',
                    sourceSessionId: 'commander-hidden-session',
                });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [
                        {
                            id: 'worktree-project',
                            displayTitle: 'Worktree',
                            rootPath: '/wt',
                            ownerProjectId: 'project-1',
                        },
                    ],
                    sessions: [],
                    selectedSessionId: undefined,
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const { instance } = authority({ getServer: server(request) });

        await expect(
            instance.openCommanderFileLink({ terminalId: 'commander', target: 'notes.md' }),
        ).resolves.toEqual({ canceled: true, reason: 'worktree_project_unbound' });
    });
});
