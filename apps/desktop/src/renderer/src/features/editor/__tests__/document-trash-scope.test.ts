import type { BootstrapState, SessionState } from '@caxri/protocol';
import { filePreviewTabPath } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    queueEditorNavigation: vi.fn(),
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
    revealEditorNavigation: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../editor-reveal', () => ({
    queueEditorNavigation: mocks.queueEditorNavigation,
    revealEditorNavigation: mocks.revealEditorNavigation,
}));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { closeOpenEditorsUnderPath, hasUnsavedChangesUnderPath } from '../document-trash';

const TRASHED = '/project/trashed.ts';
const PARKED_ROOT_FILE = '/other/session.ts';

function paneLayout(paths: readonly string[]): SessionState['paneLayout'] {
    return {
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: paths.map((path, index) => ({
                id: `tab-${index}`,
                resource: { kind: 'file' as const, path },
            })),
            ...(paths.length > 0 && { activeTabId: 'tab-0' }),
        },
        activePaneId: 'pane-1',
    };
}

function paneTabPaths(state: SessionState): string[] {
    const pane = state.paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return pane.tabs.map((tab) => (tab.resource.kind === 'file' ? tab.resource.path : ''));
}

function sessionStateOf(sessionId: string): SessionState | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
}

/**
 * Two Sessions owned by `project-1`, where `session-2` has since switched its Workbench Root to `project-2`. It keeps a
 * `/project/trashed.ts` buffer cached under the root it left, plus an unrelated buffer under the root it now shows, so
 * a Trash performed in `project-1` has both something it must reach and something it must not touch.
 */
function installParkedSession({ dirty }: { dirty: boolean }): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
                { id: 'session-2', projectId: 'project-1', workbenchRootProjectId: 'project-2' },
            ],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: paneLayout([TRASHED]),
                },
                {
                    sessionId: 'session-2',
                    workbenchRootProjectId: 'project-2',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: paneLayout([PARKED_ROOT_FILE]),
                },
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    const store = useSessionViewStore.getState();
    store.cacheDocument('session-1', {
        path: TRASHED,
        content: 'unsaved',
        dirty,
        mtimeMs: 1,
        size: 7,
    });
    // No explicit root: `session-2` resolves to `project-2`, the root it is actually showing.
    store.cacheDocument('session-2', {
        path: PARKED_ROOT_FILE,
        content: 'other unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 13,
    });
    store.cacheDocument(
        'session-2',
        { path: TRASHED, content: 'parked', dirty, mtimeMs: 1, size: 6 },
        'project-1',
    );
}

afterEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('Trash reconciliation across Workbench Roots', () => {
    it('sees and clears a buffer a Session parked on another root still holds', () => {
        // The Trash path used to reconcile only the Sessions *currently* on the deleted file's root, so this buffer was
        // neither reported by the confirmation nor evicted, and recreated the file on the next save (#738).
        installParkedSession({ dirty: true });

        expect(hasUnsavedChangesUnderPath('project-1', TRASHED)).toBe(true);
        closeOpenEditorsUnderPath('project-1', TRASHED);

        const documents = useSessionViewStore.getState().documents;
        expect(documents['session-1']).toEqual({});
        expect(documents['session-2']).toEqual({});
        expect(paneTabPaths(sessionStateOf('session-1')!)).toEqual([]);
        // The parked Session keeps the root it is actually showing: its layout and its unrelated buffer are untouched.
        expect(paneTabPaths(sessionStateOf('session-2')!)).toEqual([PARKED_ROOT_FILE]);
        expect(documents['session-2\0project-2']).toMatchObject({
            [PARKED_ROOT_FILE]: { dirty: true },
        });
    });

    it('closes the preview of a trashed file and keeps previews of other files', () => {
        // A PDF opens only as a preview, so a Trash that skipped preview tabs left the deleted document on screen.
        const keptPreview = filePreviewTabPath('/project/notes.md');
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-1',
                sessions: [
                    {
                        id: 'session-1',
                        projectId: 'project-1',
                        workbenchRootProjectId: 'project-1',
                    },
                ],
                sessionStates: [
                    {
                        sessionId: 'session-1',
                        workbenchRootProjectId: 'project-1',
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout([
                            filePreviewTabPath('/project/docs/manual.pdf'),
                            keptPreview,
                        ]),
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });

        closeOpenEditorsUnderPath('project-1', '/project/docs');

        expect(paneTabPaths(sessionStateOf('session-1')!)).toEqual([keptPreview]);
    });

    it('keeps a saved buffer under another root out of the Trash confirmation', () => {
        installParkedSession({ dirty: false });

        expect(hasUnsavedChangesUnderPath('project-1', TRASHED)).toBe(false);
    });
});
