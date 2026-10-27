import type { BootstrapState, SessionState } from '@caxri/protocol';
import { binaryFileReadError, CaxriError, filePreviewTabPath } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../editor-reveal', () => ({
    queueEditorNavigation: vi.fn(),
    revealEditorNavigation: vi.fn(),
}));

import { useSessionViewStore } from '../../../stores/session-view';
import { dismissToast, getToasts } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import { openFileForSession } from '../document-commands';

function installSession(): void {
    const state: SessionState = {
        sessionId: 'session-1',
        revision: 0,
        workbenchRootProjectId: 'project-1',
        desiredSecondarySidebarViewContainerId: 'caxri.files',
        paneLayout: {
            root: {
                type: 'pane',
                id: 'pane-1',
                tabs: [{ id: 'tab-0', resource: { kind: 'file', path: '/project/current.ts' } }],
                activeTabId: 'tab-0',
            },
            activePaneId: 'pane-1',
        },
    };
    useWorkbenchStore.setState({
        bootstrap: {
            projects: [],
            selectedSessionId: 'session-1',
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
            ],
            sessionStates: [state],
            terminals: [],
        } as unknown as BootstrapState,
    });
}

function activeTabPath(): string | undefined {
    const root = useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.paneLayout.root;
    if (root?.type !== 'pane') throw new Error('Expected a single-pane layout');
    const tab = root.tabs.find((candidate) => candidate.id === root.activeTabId);
    return tab?.resource.kind === 'file' ? tab.resource.path : undefined;
}

afterEach(() => {
    mocks.request.mockReset();
    dismissToast();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('opening a file whose only view is its preview', () => {
    it('opens a PDF straight into its preview tab without a text read', async () => {
        installSession();

        await expect(openFileForSession('session-1', '/project/docs/manual.pdf')).resolves.toBe(
            '/project/docs/manual.pdf',
        );

        expect(mocks.request).not.toHaveBeenCalledWith('files.read', expect.anything());
        expect(activeTabPath()).toBe(filePreviewTabPath('/project/docs/manual.pdf'));
        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
    });

    it('still reads a CSV as text, since its preview is a second view of the source', async () => {
        installSession();
        mocks.request.mockImplementation((method) =>
            method === 'files.read'
                ? Promise.resolve({
                      content: 'a,b\n',
                      mtimeMs: 1,
                      path: '/project/data.csv',
                      size: 4,
                  })
                : Promise.resolve(null),
        );

        await expect(openFileForSession('session-1', '/project/data.csv')).resolves.toBe(
            '/project/data.csv',
        );

        expect(mocks.request).toHaveBeenCalledWith('files.read', expect.anything());
        expect(activeTabPath()).toBe('/project/data.csv');
    });
});

describe('opening a binary file', () => {
    it('opens a no-preview tab instead of failing', async () => {
        installSession();
        mocks.request.mockImplementation((method) =>
            method === 'files.read' ? Promise.reject(binaryFileReadError()) : Promise.resolve(null),
        );

        await expect(openFileForSession('session-1', '/project/sample.bin')).resolves.toBe(
            '/project/sample.bin',
        );

        expect(activeTabPath()).toBe(filePreviewTabPath('/project/sample.bin'));
        expect(getToasts()).toEqual([]);
        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
    });

    it('reactivates the open no-preview tab without reading the file again', async () => {
        installSession();
        mocks.request.mockImplementation((method) =>
            method === 'files.read' ? Promise.reject(binaryFileReadError()) : Promise.resolve(null),
        );
        await openFileForSession('session-1', '/project/sample.bin');
        await openFileForSession('session-1', '/project/current.ts');
        mocks.request.mockClear();

        await openFileForSession('session-1', '/project/sample.bin');

        expect(mocks.request).not.toHaveBeenCalledWith('files.read', expect.anything());
        expect(activeTabPath()).toBe(filePreviewTabPath('/project/sample.bin'));
    });

    it('still reports a real read failure', async () => {
        installSession();
        mocks.request.mockImplementation((method) =>
            method === 'files.read'
                ? Promise.reject(new CaxriError('PATH_DENIED', 'Permission denied'))
                : Promise.resolve(null),
        );

        await expect(openFileForSession('session-1', '/project/locked.txt')).resolves.toBe(false);

        expect(getToasts().map((entry) => entry.type)).toEqual(['error']);
        expect(activeTabPath()).toBe('/project/current.ts');
    });
});
