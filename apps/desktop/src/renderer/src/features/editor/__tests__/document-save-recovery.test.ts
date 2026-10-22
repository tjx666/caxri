import type { BootstrapState, SessionState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() =>
    vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
);

vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));
vi.mock('../editor-reveal', () => ({
    focusEditor: vi.fn(),
    queueEditorNavigation: vi.fn(),
    revealEditorNavigation: vi.fn(),
}));

import { toastActionHandlers } from '../../../commands/toast-actions';
import { useSessionViewStore } from '../../../stores/session-view';
import { configureToastActions } from '../../../stores/toast-actions';
import { dismissToast, getToasts } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import { closeDocumentTabs, saveActiveEditor } from '../document-commands';
import { remapOpenEditors } from '../document-remap';

function installDirtyDocument(path: string): void {
    const sessionState: SessionState = {
        sessionId: 'session-1',
        revision: 0,
        workbenchProjectId: 'project-1',
        desiredSecondarySidebarViewContainerId: 'caxri.files',
        paneLayout: {
            root: {
                type: 'pane',
                id: 'pane-1',
                activeTabId: 'tab-file',
                tabs: [{ id: 'tab-file', resource: { kind: 'file', path } }],
            },
            activePaneId: 'pane-1',
        },
    };
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
            ],
            sessionStates: [sessionState],
            terminals: [],
            // Off, so closing a dirty tab asks Save/Don't Save/Cancel instead of saving on its own.
            settings: { 'files.autoSave': 'off' },
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useSessionViewStore.getState().cacheDocument('session-1', {
        path,
        content: 'unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 7,
    });
}

// The toast records only the name of its Retry; `main.tsx` performs this same install before the first render.
configureToastActions(toastActionHandlers);

afterEach(() => {
    request.mockReset();
    request.mockResolvedValue(null);
    dismissToast();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('document save recovery', () => {
    it('retries a failed save at the same editor tab current path', async () => {
        installDirtyDocument('/project/source.ts');
        request.mockRejectedValueOnce(new Error('fixture write failure')).mockResolvedValueOnce({
            content: 'unsaved',
            mtimeMs: 2,
            path: '/project/renamed.ts',
            size: 7,
        });

        await saveActiveEditor();
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        const recovery = getToasts().at(-1)?.action as { onClick?: () => void } | undefined;
        recovery?.onClick?.();

        await vi.waitFor(() =>
            expect(request).toHaveBeenLastCalledWith('files.write', {
                sessionId: 'session-1',
                path: '/project/renamed.ts',
                content: 'unsaved',
            }),
        );
    });

    it('keeps a dirty tab open when its requested save fails', async () => {
        installDirtyDocument('/project/dirty.ts');
        request.mockImplementation((method) => {
            if (method === 'editor.confirmDiscard') return Promise.resolve({ choice: 'save' });
            if (method === 'files.write') return Promise.reject(new Error('fixture write failure'));
            return Promise.resolve(null);
        });

        await closeDocumentTabs(['tab-file']);

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(state.paneLayout.root).toMatchObject({
            type: 'pane',
            tabs: [{ id: 'tab-file', resource: { path: '/project/dirty.ts' } }],
        });
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/dirty.ts': { dirty: true },
        });
    });

    it('refuses Retry when a preview replacement reuses the failed editor tab id', async () => {
        installDirtyDocument('/project/source.ts');
        request.mockRejectedValueOnce(new Error('fixture write failure'));
        await saveActiveEditor();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: state.bootstrap.sessionStates.map((session) => ({
                          ...session,
                          paneLayout: {
                              ...session.paneLayout,
                              root: {
                                  type: 'pane' as const,
                                  id: 'pane-1',
                                  activeTabId: 'tab-file',
                                  tabs: [
                                      {
                                          id: 'tab-file',
                                          preview: true,
                                          resource: {
                                              kind: 'file' as const,
                                              path: '/project/replacement.ts',
                                          },
                                      },
                                  ],
                              },
                          },
                      })),
                  }
                : undefined,
        }));

        const recovery = getToasts().at(-1)?.action as { onClick?: () => void } | undefined;
        recovery?.onClick?.();

        expect(request).toHaveBeenCalledTimes(1);
        expect(getToasts().at(-1)?.title).toContain('Save retry is no longer available');
    });
});
