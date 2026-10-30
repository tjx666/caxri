import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FileActions from '../file-actions';

type MoveFile = typeof FileActions.moveFile;

const mocks = vi.hoisted(() => ({
    closeOpenEditorsUnderPath: vi.fn<(projectId: string, path: string) => void>(),
    dirtyPaths: new Set<string>(),
    moveFile: vi.fn<MoveFile>(),
    projectIds: new Map<string, string>(),
    request: vi.fn<(method: string, parameters: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock(import('../../../../stores/selectors'), async (importOriginal) => ({
    ...(await importOriginal()),
    getSessionProjectId: (sessionId: string) => mocks.projectIds.get(sessionId),
}));
vi.mock('../../../editor/document-trash', () => ({
    closeOpenEditorsUnderPath: mocks.closeOpenEditorsUnderPath,
    hasUnsavedChangesUnderPath: (projectId: string, path: string) =>
        mocks.dirtyPaths.has(`${projectId}:${path}`),
}));
vi.mock(import('../file-actions'), async (importOriginal) => ({
    ...(await importOriginal()),
    moveFile: mocks.moveFile,
}));

import { queryClient } from '../../../../queries/client';
import { useEnvironmentStore } from '../../../../stores/environment';
import { dismissToast, getToasts } from '../../../../stores/toasts';
import { useFileClipboardStore } from '../file-clipboard';
import { importOsFiles, pasteFile, pasteIntoDirectory, rememberFile } from '../file-paste-actions';
import type { ResourceExplorerClient } from '../resource-explorer-client';
import { setResourceExplorerActiveScope } from '../resource-explorer-scope-store';

const client = {
    viewId: 'publisher.files.explorer',
    copy: (options: Parameters<ResourceExplorerClient['copy']>[0]) =>
        mocks.request('files.copy', options),
    forgetEditorPath: (projectId: string, path: string) =>
        mocks.request('editor.forget', { projectId, path }),
} as unknown as ResourceExplorerClient;

/**
 * Answers the system clipboard with `finderPaths` and every copy with an entry named after its source.
 */
function stubRequests(finderPaths: string[] = []): void {
    mocks.request.mockImplementation((method, parameters) => {
        if (method === 'clipboard.readFilePaths') return Promise.resolve({ paths: finderPaths });
        if (method === 'files.copy') {
            const name = String(parameters.path).split('/').at(-1);
            return Promise.resolve({
                kind: 'file',
                name,
                path: `${String(parameters.directory)}/${name}`,
            });
        }
        return Promise.resolve(null);
    });
}

function copyRequests(): unknown[] {
    return mocks.request.mock.calls
        .filter(([method]) => method === 'files.copy')
        .map(([, parameters]) => parameters);
}

beforeEach(() => {
    vi.stubGlobal('caxri', {});
    useEnvironmentStore.setState({ state: { kind: 'local' } });
});

afterEach(() => {
    vi.unstubAllGlobals();
    mocks.request.mockReset();
    mocks.moveFile.mockReset();
    mocks.closeOpenEditorsUnderPath.mockReset();
    mocks.dirtyPaths.clear();
    mocks.projectIds.clear();
    queryClient.clear();
    useFileClipboardStore.getState().clear();
    useEnvironmentStore.setState({ state: undefined });
    setResourceExplorerActiveScope(undefined);
    dismissToast();
});

describe('Cut or Copy across Projects', () => {
    it('remembers the Session the item was copied in and puts its path on the system clipboard', () => {
        stubRequests();
        setResourceExplorerActiveScope({
            projectId: 'project-a',
            scopeId: 'session-a:project-a',
            sessionId: 'session-a',
        });

        rememberFile('/a/notes.md', 'copy');

        expect(useFileClipboardStore.getState().entry).toEqual({
            mode: 'copy',
            path: '/a/notes.md',
            sessionId: 'session-a',
        });
        expect(mocks.request).toHaveBeenCalledWith('clipboard.write', { text: '/a/notes.md' });
    });

    it('names the source Session when pasting into another one, and nothing within the same Session', async () => {
        stubRequests();

        await pasteFile(client, 'session-b', '/b', {
            mode: 'copy',
            path: '/a/notes.md',
            sessionId: 'session-a',
        });
        await pasteFile(client, 'session-a', '/a/docs', {
            mode: 'copy',
            path: '/a/notes.md',
            sessionId: 'session-a',
        });

        expect(copyRequests()).toEqual([
            {
                path: '/a/notes.md',
                directory: '/b',
                source: { kind: 'session', sessionId: 'session-a' },
            },
            { path: '/a/notes.md', directory: '/a/docs' },
        ]);
    });
});

describe('Cut and paste into another Project', () => {
    const cut = { mode: 'cut', path: '/a/notes.md', sessionId: 'session-a' } as const;

    beforeEach(() => {
        stubRequests();
        mocks.projectIds.set('session-a', 'project-a').set('session-b', 'project-b');
        mocks.moveFile.mockResolvedValue({
            kind: 'file',
            name: 'notes.md',
            path: '/b/notes.md',
            previousPath: '/a/notes.md',
        });
    });

    it('closes and forgets the tabs the moved item left behind in its old Project', async () => {
        useFileClipboardStore.getState().set(cut);

        await pasteFile(client, 'session-b', '/b', cut);

        expect(mocks.closeOpenEditorsUnderPath).toHaveBeenCalledWith('project-a', '/a/notes.md');
        expect(mocks.request).toHaveBeenCalledWith('editor.forget', {
            projectId: 'project-a',
            path: '/a/notes.md',
        });
        expect(useFileClipboardStore.getState().entry).toBeUndefined();
    });

    it('refuses while the item has unsaved edits in its old Project', async () => {
        mocks.dirtyPaths.add('project-a:/a/notes.md');

        await expect(pasteFile(client, 'session-b', '/b', cut)).resolves.toBeUndefined();

        expect(mocks.moveFile).not.toHaveBeenCalled();
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Save or close the file before moving it to another Project',
            }),
        ]);
    });

    it('leaves the tabs to the move itself when both Sessions share a Project', async () => {
        mocks.projectIds.set('session-b', 'project-a');

        await pasteFile(client, 'session-b', '/a/docs', cut);

        expect(mocks.moveFile).toHaveBeenCalled();
        expect(mocks.closeOpenEditorsUnderPath).not.toHaveBeenCalled();
    });
});

describe('Paste from Finder', () => {
    it('copies every file Finder put on the clipboard and returns the last one', async () => {
        stubRequests(['/Users/me/Desktop/a.png', '/Users/me/Desktop/b.png']);
        useFileClipboardStore
            .getState()
            .set({ mode: 'copy', path: '/a/notes.md', sessionId: 'session-a' });

        const pasted = await pasteIntoDirectory(client, 'session-a', '/a');

        expect(copyRequests()).toEqual([
            { path: '/Users/me/Desktop/a.png', directory: '/a', source: { kind: 'external' } },
            { path: '/Users/me/Desktop/b.png', directory: '/a', source: { kind: 'external' } },
        ]);
        expect(pasted).toMatchObject({ path: '/a/b.png' });
    });

    it('pastes the item cut or copied in Caxri when Finder copied nothing', async () => {
        stubRequests([]);
        useFileClipboardStore
            .getState()
            .set({ mode: 'copy', path: '/a/notes.md', sessionId: 'session-a' });

        await pasteIntoDirectory(client, 'session-a', '/a/docs');

        expect(copyRequests()).toEqual([{ path: '/a/notes.md', directory: '/a/docs' }]);
    });

    it("never reads this Mac's Finder files in an SSH Host window", async () => {
        stubRequests(['/Users/me/Desktop/a.png']);
        useEnvironmentStore.setState({
            state: {
                kind: 'ssh',
                destination: 'builder',
                hostIdentity: 'builder',
                phase: 'connected',
                needsUserAction: false,
            },
        });

        await expect(pasteIntoDirectory(client, 'session-a', '/a')).resolves.toBeUndefined();

        expect(mocks.request).not.toHaveBeenCalledWith('clipboard.readFilePaths', {});
        expect(copyRequests()).toEqual([]);
    });

    it('copies dropped files one at a time so each picks its own free name', async () => {
        let inFlight = 0;
        let peak = 0;
        mocks.request.mockImplementation(async (_method, parameters) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { kind: 'file', name: 'x', path: `/a/${String(parameters.path)}` };
        });

        await importOsFiles(client, 'session-a', ['one', 'two', 'three'], '/a');

        expect(peak).toBe(1);
        expect(copyRequests()).toHaveLength(3);
    });
});
