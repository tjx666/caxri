import { themeImportExtensions } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: {
        showMessageBox: vi.fn(),
        showOpenDialog: vi.fn(),
        showSaveDialog: vi.fn(),
    },
    shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog, shell: electronMock.shell }));

import { deleteSessionPrompt, externalLinkPrompt } from '../confirmations';
import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

const window = {};

function requestMock(
    handlers: Partial<Record<string, (parameters?: unknown) => Promise<unknown>>>,
) {
    return vi.fn((method: string, parameters?: unknown) => {
        const found = handlers[method];
        if (!found) return Promise.reject(new Error(`Unexpected method: ${method}`));
        return found(parameters);
    });
}

function options(overrides: {
    processExplorer?: ProcessExplorerWindowController;
    request?: ReturnType<typeof requestMock>;
    updateService?: UpdateService;
    workbenchRootAuthority?: Partial<
        Record<keyof ReturnType<typeof createWorkbenchRootAuthority>, unknown>
    >;
}) {
    return {
        getAgentCommander: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () =>
            overrides.processExplorer ?? ({} as ProcessExplorerWindowController),
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
        getUserDataPath: () => '/user-data',
        getSupervisor: () =>
            ({
                request: overrides.request ?? requestMock({}),
            }) as unknown as DesktopServerConnection,
        getUpdateService: () => overrides.updateService ?? ({} as UpdateService),
        getWindow: () => window as never,
        workbenchRootAuthority: (overrides.workbenchRootAuthority ?? {}) as ReturnType<
            typeof createWorkbenchRootAuthority
        >,
    };
}

beforeEach(() => {
    electronMock.dialog.showMessageBox.mockReset();
    electronMock.dialog.showOpenDialog.mockReset();
    electronMock.dialog.showSaveDialog.mockReset();
    electronMock.shell.openExternal.mockReset();
    electronMock.shell.openPath.mockReset();
});

describe('external.open trust wiring', () => {
    let trustCalls: Array<{ domain: string }>;

    function settingsRequest(trustedDomains: string[] = []) {
        return requestMock({
            'settings.get': () =>
                Promise.resolve({
                    value: { 'security.trustedDomains': trustedDomains },
                    source: 'default',
                }),
            'settings.trustDomain': (parameters) => {
                trustCalls.push(parameters as { domain: string });
                return Promise.resolve({ value: {}, source: 'default' });
            },
        });
    }

    beforeEach(() => {
        trustCalls = [];
    });

    it('routes real confirmation copy through the fixed Acceptance I/O without native side effects', async () => {
        const url = new URL('https://github.com/tjx666/project/pull/42');
        const fixture = {
            prompt: vi.fn().mockResolvedValue({ response: 0 }),
            open: vi.fn().mockResolvedValue(undefined),
        };
        const handle = createMainMethodHandler({
            ...options({ request: settingsRequest([]) }),
            externalOpenFixture: fixture,
        });
        await expect(
            handle({ method: 'external.open', params: { url: url.href } }),
        ).resolves.toEqual({ status: 'opened' });
        expect(fixture.prompt).toHaveBeenCalledWith(url, externalLinkPrompt(url, true));
        expect(fixture.open).toHaveBeenCalledWith(url.href);
        fixture.prompt.mockResolvedValue({ response: 2 });
        fixture.open.mockClear();
        await expect(
            handle({ method: 'external.open', params: { url: url.href } }),
        ).resolves.toEqual({ status: 'canceled' });
        expect(fixture.open).not.toHaveBeenCalled();
        expect(trustCalls).toEqual([]);
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
    });

    it('opens directly for an already trusted domain without prompting', async () => {
        const request = settingsRequest(['https://example.com']);
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'external.open', params: { url: 'https://example.com/page' } }),
        ).resolves.toEqual({ status: 'opened' });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(electronMock.shell.openExternal).toHaveBeenCalledWith('https://example.com/page');
    });

    it('prompts for an untrusted domain and persists trust before opening', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = settingsRequest([]);
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'external.open', params: { url: 'https://example.com/page' } }),
        ).resolves.toEqual({ status: 'opened' });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            window,
            expect.objectContaining({ buttons: ['Open Once', 'Trust Domain and Open', 'Cancel'] }),
        );
        expect(trustCalls).toEqual([{ domain: 'https://example.com' }]);
        expect(electronMock.shell.openExternal).toHaveBeenCalledWith('https://example.com/page');
    });

    it('opens once without persisting trust and cancels without opening', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = settingsRequest([]);
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'external.open', params: { url: 'https://example.com/page' } }),
        ).resolves.toEqual({ status: 'opened' });
        expect(trustCalls).toEqual([]);
    });

    it('rejects a disallowed URL scheme before ever prompting', async () => {
        const request = settingsRequest([]);
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'external.open', params: { url: 'file:///etc/passwd' } }),
        ).resolves.toEqual({ status: 'rejected', reason: 'unsupported_protocol' });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
    });
});

describe('session.delete Acceptance confirmation', () => {
    const bootstrap = {
        projects: [],
        sessions: [{ displayTitle: 'Fixture naming hold', id: 'session-1', projectId: 'p1' }],
    };

    function deleteRequest() {
        return requestMock({
            'app.bootstrap': () => Promise.resolve(bootstrap),
            'session.delete': () => Promise.resolve({ deleted: true }),
            'terminal.runningCount': () => Promise.resolve({ terminals: 0, chats: 0 }),
        });
    }

    it('routes the real confirmation copy through the fixture and honours its answer', async () => {
        const request = deleteRequest();
        const confirm = vi.fn().mockResolvedValue({ response: 0 });
        const handle = createMainMethodHandler({
            ...options({ request }),
            acceptanceSessionDeleteFixture: { confirm },
        });

        await expect(
            handle({ method: 'session.delete', params: { sessionId: 'session-1' } }),
        ).resolves.toEqual({ deleted: true });
        expect(confirm).toHaveBeenCalledWith(
            'session-1',
            deleteSessionPrompt('Fixture naming hold', { terminals: 0, chats: 0 }),
        );
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();

        confirm.mockResolvedValueOnce({ response: 1 });
        await expect(
            handle({ method: 'session.delete', params: { sessionId: 'session-1' } }),
        ).resolves.toEqual({ canceled: true });
        // A non-zero answer must stop at Main: only the confirmed first deletion reached the Server.
        expect(request.mock.calls.filter(([method]) => method === 'session.delete')).toHaveLength(
            1,
        );
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('leaves bulk and Project deletion on the real native confirmation', async () => {
        const request = requestMock({
            'app.bootstrap': () => Promise.resolve(bootstrap),
            'terminal.runningCount': () => Promise.resolve({ terminals: 0, chats: 0 }),
        });
        const handle = createMainMethodHandler({
            ...options({ request }),
            acceptanceSessionDeleteFixture: { confirm: vi.fn() },
        });
        electronMock.dialog.showMessageBox.mockResolvedValue({ response: 1 });

        await expect(
            handle({ method: 'session.deleteMany', params: { sessionIds: ['session-1'] } }),
        ).resolves.toEqual({ canceled: true });
        await expect(
            handle({ method: 'project.delete', params: { projectId: 'p1' } }),
        ).resolves.toEqual({ canceled: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    });
});

describe('theme.import', () => {
    it('uses the fixed Acceptance file selection without opening a native dialog', async () => {
        const request = requestMock({ 'theme.importPath': () => Promise.resolve({ tokens: {} }) });
        const choose = vi.fn().mockResolvedValue('/test-root/theme.json');
        const handle = createMainMethodHandler({
            ...options({ request }),
            acceptanceThemeImportFixture: { choose },
        });

        await expect(handle({ method: 'theme.import', params: {} })).resolves.toEqual({
            tokens: {},
        });
        expect(request).toHaveBeenCalledWith('theme.importPath', {
            path: '/test-root/theme.json',
        });
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();

        choose.mockRejectedValueOnce(new Error('Invalid command'));
        await expect(handle({ method: 'theme.import', params: {} })).rejects.toThrow(
            'Invalid command',
        );
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('returns null without importing when the dialog is dismissed', async () => {
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
        const request = requestMock({});
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'theme.import', params: {} })).resolves.toBeNull();
        expect(request).not.toHaveBeenCalled();
    });

    it('imports the selected theme file', async () => {
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/themes/dark.json'],
        });
        const request = requestMock({
            'theme.importPath': () => Promise.resolve({ tokens: {} }),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'theme.import', params: {} })).resolves.toEqual({
            tokens: {},
        });
        expect(request).toHaveBeenCalledWith('theme.importPath', { path: '/themes/dark.json' });
        expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                filters: [
                    {
                        name: 'Theme files',
                        extensions: [...themeImportExtensions, 'vsix'],
                    },
                    { name: 'All Files', extensions: ['*'] },
                ],
            }),
        );
    });
});

describe('editor.confirmDiscard', () => {
    it('maps the native dialog response to a discard choice', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const handle = createMainMethodHandler(options({}));

        await expect(
            handle({ method: 'editor.confirmDiscard', params: { name: 'index.ts' } }),
        ).resolves.toEqual({ choice: 'discard' });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            window,
            expect.objectContaining({
                message: "Do you want to save the changes you made to 'index.ts'?",
            }),
        );
    });
});

describe('mobile.device.revoke', () => {
    const device = {
        createdAt: 1,
        deviceId: `device_${'01'.repeat(16)}`,
        displayName: 'Pixel 8',
        generation: 3,
        platform: 'android' as const,
        projectIds: ['project-1'],
    };

    it('does not revoke when the native confirmation is dismissed', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = requestMock({
            'mobile.device.list': () => Promise.resolve({ devices: [device] }),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'mobile.device.revoke', params: { deviceId: device.deviceId } }),
        ).resolves.toEqual({ canceled: true });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('binds confirmed revocation to the current device generation', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const revoked = { ...device, generation: 4, revokedAt: 2 };
        const request = requestMock({
            'mobile.device.list': () => Promise.resolve({ devices: [device] }),
            'mobile.device.revoke.apply': () => Promise.resolve(revoked),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(
            handle({ method: 'mobile.device.revoke', params: { deviceId: device.deviceId } }),
        ).resolves.toEqual(revoked);
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            window,
            expect.objectContaining({ message: "Revoke 'Pixel 8'?" }),
        );
        expect(request).toHaveBeenLastCalledWith('mobile.device.revoke.apply', {
            deviceId: device.deviceId,
            expectedGeneration: 3,
        });
    });
});

describe('diagnostics.export', () => {
    it('returns null without exporting when the save dialog is dismissed', async () => {
        electronMock.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
        const request = requestMock({});
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'diagnostics.export', params: {} })).resolves.toBeNull();
        expect(request).not.toHaveBeenCalled();
    });

    it('exports to the chosen destination with an extended timeout', async () => {
        electronMock.dialog.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/exports/diagnostics.zip',
        });
        const request = requestMock({
            'diagnostics.exportPath': () => Promise.resolve({ path: '/exports/diagnostics.zip' }),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'diagnostics.export', params: {} })).resolves.toEqual({
            path: '/exports/diagnostics.zip',
        });
        expect(request).toHaveBeenCalledWith(
            'diagnostics.exportPath',
            { destination: '/exports/diagnostics.zip' },
            60_000,
        );
    });
});

describe('processExplorer.open', () => {
    it('opens the Process Explorer window and resolves to null', async () => {
        const open = vi.fn();
        const handle = createMainMethodHandler(
            options({ processExplorer: { open } as unknown as ProcessExplorerWindowController }),
        );

        await expect(handle({ method: 'processExplorer.open', params: {} })).resolves.toBeNull();
        expect(open).toHaveBeenCalledOnce();
    });
});

describe('path browser routing', () => {
    it('keeps every opaque browser operation inside the workbench root authority', async () => {
        const pathBrowser = {
            start: vi.fn(() => Promise.resolve({ browserId: 'browser-1' })),
            browse: vi.fn(() => Promise.resolve({ browserId: 'browser-1' })),
            navigate: vi.fn(() => Promise.resolve({ canceled: true })),
            open: vi.fn(() => Promise.resolve({ opened: true })),
            close: vi.fn(() => null),
        };
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { pathBrowser } }),
        );

        await handle({ method: 'pathBrowser.start', params: { sessionId: 'session-1' } });
        await handle({
            method: 'pathBrowser.browse',
            params: { browserId: 'browser-1', mode: 'project', input: 'src' },
        });
        await handle({
            method: 'pathBrowser.navigate',
            params: { browserId: 'browser-1', target: { kind: 'parent' } },
        });
        await handle({
            method: 'pathBrowser.open',
            params: { browserId: 'browser-1', entryId: 'entry-1' },
        });
        await handle({ method: 'pathBrowser.close', params: { browserId: 'browser-1' } });

        expect(pathBrowser.start).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(pathBrowser.browse).toHaveBeenCalledWith({
            browserId: 'browser-1',
            mode: 'project',
            input: 'src',
        });
        expect(pathBrowser.navigate).toHaveBeenCalledWith({
            browserId: 'browser-1',
            target: { kind: 'parent' },
        });
        expect(pathBrowser.open).toHaveBeenCalledWith({
            browserId: 'browser-1',
            entryId: 'entry-1',
        });
        expect(pathBrowser.close).toHaveBeenCalledWith({ browserId: 'browser-1' });
    });
});

describe('updates.* delegation', () => {
    it.each([
        ['updates.getState', 'getState'],
        ['updates.check', 'check'],
        ['updates.acknowledge', 'acknowledge'],
        ['updates.download', 'download'],
        ['updates.cancel', 'cancel'],
        ['updates.open', 'open'],
    ] as const)('forwards %s to the injected update service', async (method, serviceMethod) => {
        const state = { status: 'idle' };
        const updateService = {
            [serviceMethod]: vi.fn(() => Promise.resolve(state)),
        } as unknown as UpdateService;
        const handle = createMainMethodHandler(options({ updateService }));

        await expect(handle({ method, params: {} })).resolves.toBe(state);
        expect((updateService as never)[serviceMethod]).toHaveBeenCalledOnce();
    });
});

describe('Workbench Root Authority delegation', () => {
    it('forwards dialog.selectDirectory to the authority', async () => {
        const selectProjectFolder = vi.fn(() => Promise.resolve('/picked/root'));
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { selectProjectFolder } }),
        );

        await expect(handle({ method: 'dialog.selectDirectory', params: {} })).resolves.toBe(
            '/picked/root',
        );
        expect(selectProjectFolder).toHaveBeenCalledOnce();
    });

    it('forwards project.create with its params to the authority', async () => {
        const createProject = vi.fn(() => Promise.resolve({ id: 'project-1' }));
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { createProject } }),
        );

        await expect(
            handle({ method: 'project.create', params: { rootPath: '/root' } }),
        ).resolves.toEqual({ id: 'project-1' });
        expect(createProject).toHaveBeenCalledWith({ rootPath: '/root' });
    });

    it('forwards project.cancelCreate with its params to the authority', async () => {
        const cancelProjectCreate = vi.fn(() => null);
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { cancelProjectCreate } }),
        );

        await expect(
            handle({ method: 'project.cancelCreate', params: { rootPath: '/root' } }),
        ).resolves.toBeNull();
        expect(cancelProjectCreate).toHaveBeenCalledWith({ rootPath: '/root' });
    });

    it('forwards session.authorizeWorkbenchRoot with its params to the authority', async () => {
        const authorizeSelection = vi.fn(() => Promise.resolve({ id: 'session-1' }));
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { authorizeSelection } }),
        );

        await expect(
            handle({
                method: 'session.authorizeWorkbenchRoot',
                params: { sessionId: 'session-1', worktreeId: 'worktree-1' },
            }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(authorizeSelection).toHaveBeenCalledWith({
            sessionId: 'session-1',
            worktreeId: 'worktree-1',
        });
    });

    it('forwards session.continueInWorktree with its params to the authority', async () => {
        const continueInWorktree = vi.fn(() => Promise.resolve({ id: 'session-1' }));
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { continueInWorktree } }),
        );

        await expect(
            handle({
                method: 'session.continueInWorktree',
                params: { candidateId: 'candidate-1', sessionId: 'session-1' },
            }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(continueInWorktree).toHaveBeenCalledWith({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
        });
    });
});

describe('git.discard', () => {
    const parameters = {
        sessionId: 'session-1',
        repositoryId: 'repo-1',
        repositoryName: 'project',
        scope: { kind: 'file', path: 'tracked.txt', untracked: false },
    } as const;

    it('returns canceled without forwarding when the confirmation is dismissed', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const request = requestMock({
            'git.discard.preflight': () =>
                Promise.resolve({
                    status: 'ready',
                    token: 'discard-token',
                    repositoryName: 'canonical-project',
                    scope: { kind: 'file', path: 'tracked.txt', untracked: false },
                }),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'git.discard', params: parameters })).resolves.toEqual({
            canceled: true,
        });
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith('git.discard.preflight', {
            repositoryId: parameters.repositoryId,
            scope: { kind: 'file', path: parameters.scope.path },
            sessionId: parameters.sessionId,
        });
    });

    it('forwards the discard to the Server once the destructive choice is confirmed', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const request = requestMock({
            'git.discard.preflight': () =>
                Promise.resolve({
                    status: 'ready',
                    token: 'discard-token',
                    repositoryName: 'canonical-project',
                    scope: { kind: 'file', path: 'tracked.txt', untracked: false },
                }),
            'git.discard.apply': () => Promise.resolve(null),
        });
        const handle = createMainMethodHandler(options({ request }));

        await expect(handle({ method: 'git.discard', params: parameters })).resolves.toBeNull();
        expect(request).toHaveBeenNthCalledWith(1, 'git.discard.preflight', {
            repositoryId: parameters.repositoryId,
            scope: { kind: 'file', path: parameters.scope.path },
            sessionId: parameters.sessionId,
        });
        expect(request).toHaveBeenNthCalledWith(2, 'git.discard.apply', {
            token: 'discard-token',
        });
    });
});
