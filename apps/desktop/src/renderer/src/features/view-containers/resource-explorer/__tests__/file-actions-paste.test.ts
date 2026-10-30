import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { queryClient } from '../../../../queries/client';
import { useEnvironmentStore } from '../../../../stores/environment';
import { dismissToast } from '../../../../stores/toasts';
import { importOsFiles, pasteFile, pasteIntoDirectory, rememberFile } from '../file-actions';
import { useFileClipboardStore } from '../file-clipboard';
import type { ResourceExplorerClient } from '../resource-explorer-client';
import { setResourceExplorerActiveScope } from '../resource-explorer-scope-store';

const client = {
    viewId: 'publisher.files.explorer',
    copy: (options: Parameters<ResourceExplorerClient['copy']>[0]) =>
        mocks.request('files.copy', options),
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
