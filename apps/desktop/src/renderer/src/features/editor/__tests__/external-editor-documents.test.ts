import type { BootstrapState, SessionState } from '@caxri/protocol';
import { findResourceTabs, MAX_TABS_PER_PANE } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as EditorReveal from '../editor-reveal';

const mocks = vi.hoisted(() => ({
    focusEditor: vi.fn<(path: string) => void>(),
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../editor-reveal', async (importOriginal) => ({
    ...(await importOriginal<typeof EditorReveal>()),
    focusEditor: mocks.focusEditor,
}));

import { getSessionDocuments, useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { changeDocument, closeDocumentTabs, saveActiveEditor } from '../document-commands';
import { openExternalEditorDocument } from '../external-editor-documents';
import { resetExternalEditorStateForTests } from '../external-editor-state';

function installSession(tabCount = 0): void {
    const tabs = Array.from({ length: tabCount }, (_, index) => ({
        id: `tab-${index}`,
        resource: { kind: 'file' as const, path: `/project/file-${index}.ts` },
    }));
    const state: SessionState = {
        sessionId: 'session-1',
        revision: 0,
        workbenchProjectId: 'project-1',
        desiredSecondarySidebarViewContainerId: 'caxri.files',
        paneLayout: {
            root: {
                type: 'pane',
                id: 'pane-1',
                tabs,
                ...(tabs[0] && { activeTabId: tabs[0].id }),
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
            sessionStates: [state],
            terminals: [],
            // Off, so closing a dirty tab asks Save/Don't Save/Cancel instead of saving on its own.
            settings: { 'files.autoSave': 'off' },
        } as unknown as BootstrapState,
    });
}

afterEach(() => {
    mocks.focusEditor.mockClear();
    mocks.request.mockClear();
    resetExternalEditorStateForTests();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0, isFullScreen: false });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('external editor documents', () => {
    it('opens authorized content as an editable ephemeral tab and saves it through Main', async () => {
        installSession();

        const path = openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document: {
                id: 'external-1',
                name: 'doctor.config.jsonc',
                displayPath: '/Users/me/code/caxri/doctor.config.jsonc',
                content: '{ "before": true }',
                mtimeMs: 10,
                size: 18,
            },
        });

        expect(path).toBe('caxri-external-file://external-1/doctor.config.jsonc');
        if (!path) throw new Error('Expected an external editor path');
        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        const occurrence = findResourceTabs(state.paneLayout, { kind: 'file', path }).at(0);
        expect(occurrence?.pane.activeTabId).toBe(occurrence?.tab.id);
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: '{ "before": true }',
            dirty: false,
            displayPath: '/Users/me/code/caxri/doctor.config.jsonc',
            ephemeral: true,
        });
        expect(mocks.request).not.toHaveBeenCalled();

        changeDocument('session-1', 'project-1', path, 'changed');
        expect(getSessionDocuments('session-1', 'project-1')?.[path]?.dirty).toBe(true);
        mocks.request.mockResolvedValueOnce({ content: 'changed', mtimeMs: 20, size: 7 });
        await saveActiveEditor();

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('externalDocument.write', {
            documentId: 'external-1',
            content: 'changed',
        });
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: 'changed',
            dirty: false,
            displayPath: '/Users/me/code/caxri/doctor.config.jsonc',
            ephemeral: true,
            mtimeMs: 20,
        });

        mocks.request.mockClear();
        await closeDocumentTabs([occurrence!.tab.id]);
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toBeUndefined();
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('focuses the opened editor only when the opener asks for it', () => {
        installSession();
        const document = {
            id: 'external-1',
            name: 'notes.txt',
            displayPath: '/tmp/notes.txt',
            content: 'notes',
            mtimeMs: 10,
            size: 5,
        };

        openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document,
        });
        expect(mocks.focusEditor).not.toHaveBeenCalled();

        openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document,
            focus: true,
        });
        expect(mocks.focusEditor).toHaveBeenCalledWith(
            'caxri://session/session-1/external/external-1/notes.txt',
        );
    });

    it('asks before closing an external tab with unsaved edits', async () => {
        installSession();
        const path = openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document: {
                id: 'external-1',
                name: 'notes.md',
                displayPath: '/tmp/notes.md',
                content: 'before',
                mtimeMs: 10,
                size: 6,
            },
        });
        if (!path) throw new Error('Expected an external editor path');
        changeDocument('session-1', 'project-1', path, 'after');
        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        const tabId = findResourceTabs(state.paneLayout, { kind: 'file', path }).at(0)!.tab.id;
        mocks.request.mockResolvedValueOnce({ choice: 'cancel' });

        await closeDocumentTabs([tabId]);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('editor.confirmDiscard', {
            name: 'notes.md',
        });
        expect(getSessionDocuments('session-1', 'project-1')?.[path]?.content).toBe('after');
    });

    it('keeps unsaved edits when the same file is opened again', () => {
        installSession();
        const document = {
            id: 'external-1',
            name: 'notes.md',
            displayPath: '/tmp/notes.md',
            content: 'before',
            mtimeMs: 10,
            size: 6,
        };
        const path = openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document,
        });
        if (!path) throw new Error('Expected an external editor path');
        changeDocument('session-1', 'project-1', path, 'unsaved');

        expect(
            openExternalEditorDocument({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                document: { ...document, id: 'external-2', content: 'from disk' },
            }),
        ).toBe(path);
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: 'unsaved',
            dirty: true,
        });
    });

    it('reuses the open tab identity when Main refreshes the same external path', () => {
        installSession();

        const firstPath = openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document: {
                id: 'external-1',
                name: 'outside.sql',
                displayPath: '/tmp/outside.sql',
                content: 'select 1;',
                mtimeMs: 10,
                size: 9,
            },
        });
        const refreshedPath = openExternalEditorDocument({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            document: {
                id: 'external-2',
                name: 'outside.sql',
                displayPath: '/tmp/outside.sql',
                content: 'select 2;',
                mtimeMs: 20,
                size: 9,
            },
        });

        expect(refreshedPath).toBe(firstPath);
        if (!firstPath) throw new Error('Expected an external editor path');
        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(findResourceTabs(state.paneLayout, { kind: 'file', path: firstPath })).toHaveLength(
            1,
        );
        expect(getSessionDocuments('session-1', 'project-1')?.[firstPath]).toMatchObject({
            content: 'select 2;',
            displayPath: '/tmp/outside.sql',
            mtimeMs: 20,
        });
    });

    it('rejects a stale Workbench Project without caching content', () => {
        installSession();

        expect(
            openExternalEditorDocument({
                sessionId: 'session-1',
                workbenchProjectId: 'project-2',
                document: {
                    id: 'external-1',
                    name: 'outside.ts',
                    displayPath: '/outside.ts',
                    content: 'outside',
                    mtimeMs: 10,
                    size: 7,
                },
            }),
        ).toBe(false);
        expect(getSessionDocuments('session-1', 'project-2')).toBeUndefined();
    });

    it('does not retain content when the active pane cannot accept another tab', () => {
        installSession(MAX_TABS_PER_PANE);

        expect(
            openExternalEditorDocument({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                document: {
                    id: 'external-full-pane',
                    name: 'outside.ts',
                    displayPath: '/outside.ts',
                    content: 'outside',
                    mtimeMs: 10,
                    size: 7,
                },
            }),
        ).toBe(false);
        expect(
            getSessionDocuments('session-1', 'project-1')?.[
                'caxri-external-file://external-full-pane/outside.ts'
            ],
        ).toBeUndefined();
        expect(mocks.request).not.toHaveBeenCalled();
    });
});
