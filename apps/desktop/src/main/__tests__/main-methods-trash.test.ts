import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn() },
    shell: { trashItem: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog, shell: electronMock.shell }));

import type { RunningWork } from '../confirmations';
import type { MainEnvironmentMethods } from '../main-environment-methods';
import { unconfiguredEnvironment } from '../main-environment-methods';
import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

const NOTHING_RUNNING: RunningWork = { terminals: 0, chats: 0 };

const authorizedItem = {
    kind: 'file' as const,
    name: 'notes.md',
    path: '/project/notes.md',
    device: '1',
    inode: '2',
    root: { path: '/project', device: '1', inode: '1' },
};

function handler(
    request: (method: string, parameters?: unknown) => Promise<unknown>,
    environment?: MainEnvironmentMethods,
) {
    return createMainMethodHandler({
        environment,
        getAgentCommander: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
        getUserDataPath: () => '/user-data',
        getSupervisor: () => ({ request }) as unknown as DesktopServerConnection,
        getUpdateService: () => ({}) as UpdateService,
        getWindow: () => ({}) as never,
        workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
    });
}

beforeEach(() => {
    electronMock.dialog.showMessageBox.mockReset();
    electronMock.shell.trashItem.mockReset();
});

describe('files.trash', () => {
    function router(secondAuthorization: typeof authorizedItem = authorizedItem) {
        let authorizeCalls = 0;
        return vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>((method) => {
            if (method === 'files.authorizeTrash') {
                authorizeCalls += 1;
                return Promise.resolve(authorizeCalls === 1 ? authorizedItem : secondAuthorization);
            }
            if (method === 'files.trashOnHost') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
    }

    it('trashes the item once the user confirms and reauthorization still matches', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = router();
        const handle = handler(request);

        await expect(
            handle({
                method: 'files.trash',
                params: { sessionId: 'session-1', path: '/project/notes.md' },
            }),
        ).resolves.toEqual(authorizedItem);
        expect(electronMock.shell.trashItem).toHaveBeenCalledWith(authorizedItem.path);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it("moves an SSH Host window's item into that host's Trash instead of this Mac's", async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = router();
        const handle = handler(request, {
            ...unconfiguredEnvironment,
            get: () => ({
                kind: 'ssh',
                destination: 'devbox',
                phase: 'connected',
                needsUserAction: false,
            }),
        });

        await expect(
            handle({
                method: 'files.trash',
                params: { sessionId: 'session-1', path: '/project/notes.md' },
            }),
        ).resolves.toEqual(authorizedItem);
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                detail: expect.stringContaining('the Trash on devbox') as unknown,
            }),
        );
        expect(request).toHaveBeenLastCalledWith('files.trashOnHost', {
            sessionId: 'session-1',
            path: authorizedItem.path,
            device: authorizedItem.device,
            inode: authorizedItem.inode,
        });
        expect(electronMock.shell.trashItem).not.toHaveBeenCalled();
    });

    it('returns canceled without a second authorization or Trash call when the user declines', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = router();
        const handle = handler(request);

        await expect(
            handle({
                method: 'files.trash',
                params: { sessionId: 'session-1', path: '/project/notes.md' },
            }),
        ).resolves.toEqual({ canceled: true });
        expect(electronMock.shell.trashItem).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['path', { ...authorizedItem, path: '/project/renamed.md' }],
        ['device', { ...authorizedItem, device: '9' }],
        ['inode', { ...authorizedItem, inode: '9' }],
        ['root.path', { ...authorizedItem, root: { ...authorizedItem.root, path: '/other' } }],
        ['root.device', { ...authorizedItem, root: { ...authorizedItem.root, device: '9' } }],
        ['root.inode', { ...authorizedItem, root: { ...authorizedItem.root, inode: '9' } }],
    ])(
        'refuses to trash when %s changed between confirmation and dispatch',
        async (_field, changed) => {
            electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
            const request = router(changed);
            const handle = handler(request);

            await expect(
                handle({
                    method: 'files.trash',
                    params: { sessionId: 'session-1', path: '/project/notes.md' },
                }),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(electronMock.shell.trashItem).not.toHaveBeenCalled();
        },
    );
});

const bootstrapWith = (
    projects: Array<{ id: string; displayTitle: string }>,
    sessions: Array<{ id: string; projectId: string; displayTitle?: string }>,
) => ({
    projects,
    sessions,
    terminals: [],
    sessionStates: [],
    settings: {},
    keybindings: [],
    keybindingConflicts: [],
    theme: {},
    runtime: { status: 'ready', restartCount: 0 },
});

describe('project.delete', () => {
    it('deletes only after the user confirms and sums running Terminals and Chats across the Project Sessions', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const runningCounts: Record<string, RunningWork> = {
            'session-1': { terminals: 2, chats: 0 },
            'session-2': { terminals: 0, chats: 1 },
        };
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(
                    bootstrapWith(
                        [{ id: 'project-1', displayTitle: 'Caxri' }],
                        [
                            { id: 'session-1', projectId: 'project-1' },
                            { id: 'session-2', projectId: 'project-1' },
                            { id: 'session-3', projectId: 'other-project' },
                        ],
                    ),
                );
            if (method === 'terminal.runningCount')
                return Promise.resolve(
                    runningCounts[(parameters as { sessionId: string }).sessionId] ??
                        NOTHING_RUNNING,
                );
            if (method === 'project.delete') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({ method: 'project.delete', params: { projectId: 'project-1' } }),
        ).resolves.toEqual({ ok: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                message: "Delete 'Caxri' and terminate 2 running Terminals and 1 running Chat?",
            }),
        );
        expect(request).toHaveBeenCalledWith('project.delete', { projectId: 'project-1' });
    });

    it('cancels without deleting when the user dismisses the confirmation', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(
                    bootstrapWith([{ id: 'project-1', displayTitle: 'Caxri' }], []),
                );
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({ method: 'project.delete', params: { projectId: 'project-1' } }),
        ).resolves.toEqual({ canceled: true });
        expect(request).not.toHaveBeenCalledWith('project.delete', expect.anything());
    });

    it('falls back to a generic title when the Project is missing from bootstrap state', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrapWith([], []));
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            if (method === 'project.delete') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await handle({ method: 'project.delete', params: { projectId: 'missing-project' } });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ message: "Delete 'this Project'?" }),
        );
    });
});

describe('session.delete', () => {
    it('deletes only after confirmation and names the running Terminals and Chats', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'terminal.runningCount') {
                expect(parameters).toEqual({ sessionId: 'session-1' });
                return Promise.resolve({ terminals: 1, chats: 2 });
            }
            if (method === 'app.bootstrap')
                return Promise.resolve(
                    bootstrapWith(
                        [],
                        [{ id: 'session-1', projectId: 'project-1', displayTitle: 'Feature work' }],
                    ),
                );
            if (method === 'session.delete') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({ method: 'session.delete', params: { sessionId: 'session-1' } }),
        ).resolves.toEqual({ ok: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                message:
                    "Delete 'Feature work' and terminate 1 running Terminal and 2 running Chats?",
            }),
        );
        expect(request).toHaveBeenCalledWith('session.delete', { sessionId: 'session-1' });
    });

    it('cancels without deleting when the user dismisses the confirmation', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            if (method === 'app.bootstrap') return Promise.resolve(bootstrapWith([], []));
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({ method: 'session.delete', params: { sessionId: 'session-1' } }),
        ).resolves.toEqual({ canceled: true });
        expect(request).not.toHaveBeenCalledWith('session.delete', expect.anything());
    });

    it('falls back to a generic title when the Session is missing from bootstrap state', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            if (method === 'app.bootstrap') return Promise.resolve(bootstrapWith([], []));
            if (method === 'session.delete') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await handle({ method: 'session.delete', params: { sessionId: 'missing-session' } });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ message: "Delete 'this Session'?" }),
        );
    });
});

describe('session.deleteMany', () => {
    it('asks once for the whole batch, summing running Terminals and Chats across Sessions', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'terminal.runningCount')
                return Promise.resolve(
                    (parameters as { sessionId: string }).sessionId === 'session-1'
                        ? { terminals: 2, chats: 0 }
                        : { terminals: 0, chats: 1 },
                );
            if (method === 'session.deleteMany') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({
                method: 'session.deleteMany',
                params: { sessionIds: ['session-1', 'session-2'] },
            }),
        ).resolves.toEqual({ ok: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledOnce();
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                message: 'Delete 2 Sessions and terminate 2 running Terminals and 1 running Chat?',
            }),
        );
        expect(request).toHaveBeenCalledWith('session.deleteMany', {
            sessionIds: ['session-1', 'session-2'],
        });
    });

    it('names the Session when the batch holds exactly one', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            if (method === 'app.bootstrap')
                return Promise.resolve(
                    bootstrapWith(
                        [],
                        [{ id: 'session-1', projectId: 'project-1', displayTitle: 'Feature work' }],
                    ),
                );
            if (method === 'session.deleteMany') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await handle({ method: 'session.deleteMany', params: { sessionIds: ['session-1'] } });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ message: "Delete 'Feature work'?" }),
        );
    });

    it('cancels the whole batch when the user dismisses the confirmation', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = vi.fn((method: string) => {
            if (method === 'terminal.runningCount') return Promise.resolve(NOTHING_RUNNING);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const handle = handler(request);

        await expect(
            handle({
                method: 'session.deleteMany',
                params: { sessionIds: ['session-1', 'session-2'] },
            }),
        ).resolves.toEqual({ canceled: true });
        expect(request).not.toHaveBeenCalledWith('session.deleteMany', expect.anything());
    });
});
