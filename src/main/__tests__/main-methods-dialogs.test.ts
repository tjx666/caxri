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

import type { DesktopHostConnection } from '../host-connection';
import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
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
        getProcessExplorer: () =>
            overrides.processExplorer ?? ({} as ProcessExplorerWindowController),
        getUserDataPath: () => '/user-data',
        getSupervisor: () =>
            ({ request: overrides.request ?? requestMock({}) }) as unknown as DesktopHostConnection,
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

describe('theme.import', () => {
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

describe('updates.* delegation', () => {
    it.each([
        ['updates.getState', 'getState'],
        ['updates.check', 'check'],
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
        const selectProjectDirectory = vi.fn(() => Promise.resolve('/picked/root'));
        const handle = createMainMethodHandler(
            options({ workbenchRootAuthority: { selectProjectDirectory } }),
        );

        await expect(handle({ method: 'dialog.selectDirectory', params: {} })).resolves.toBe(
            '/picked/root',
        );
        expect(selectProjectDirectory).toHaveBeenCalledOnce();
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
                params: { sessionId: 'session-1' },
            }),
        ).resolves.toEqual({ id: 'session-1' });
        expect(authorizeSelection).toHaveBeenCalledWith({ sessionId: 'session-1' });
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
