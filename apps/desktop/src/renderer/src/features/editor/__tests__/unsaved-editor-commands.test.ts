import type { EditorDocument, SessionDocuments } from '@desktop-shared/editor-state';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: unknown) => Promise<unknown>>(),
    onEvent: vi.fn<(listener: (event: unknown) => void) => () => void>(),
    pushToast: vi.fn(),
}));
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, onEvent: mocks.onEvent },
}));
vi.mock('../../../stores/toasts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    pushToast: mocks.pushToast,
}));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    listUnsavedEditorDocuments,
    subscribeUnsavedEditorRequests,
    unreachableUnsavedEditorsMessage,
    unsavedEditorName,
    unsavedEditorNames,
} from '../unsaved-editor-commands';

function document(path: string, overrides: Partial<EditorDocument> = {}): EditorDocument {
    return { path, content: 'draft', dirty: true, mtimeMs: 1, size: 5, ...overrides };
}

const bootstrap = {
    selectedSessionId: 'session-2',
    sessions: [{ id: 'session-1' }, { id: 'session-2' }] as never,
};

describe('listUnsavedEditorDocuments', () => {
    it('lists only dirty, writable, savable buffers of live Sessions, the selected Session first', () => {
        const documents: SessionDocuments = {
            'session-1': {
                '/project/a.ts': document('/project/a.ts'),
                '/project/clean.ts': document('/project/clean.ts', { dirty: false }),
                '/project/locked.ts': document('/project/locked.ts', { readOnly: true }),
            },
            'session-2': { '/project/b.ts': document('/project/b.ts') },
            'session-gone': { '/project/c.ts': document('/project/c.ts') },
        };

        expect(listUnsavedEditorDocuments(documents, bootstrap, (id) => id)).toEqual([
            { sessionId: 'session-2', path: '/project/b.ts', isActiveRoot: true },
            { sessionId: 'session-1', path: '/project/a.ts', isActiveRoot: true },
        ]);
    });

    it('marks a buffer retained under an inactive Workbench Root as unsavable from here', () => {
        const documents: SessionDocuments = {
            'session-2\0project-worktree': { '/worktree/a.ts': document('/worktree/a.ts') },
            'session-2': { '/project/b.ts': document('/project/b.ts') },
        };

        expect(listUnsavedEditorDocuments(documents, bootstrap, (id) => id)).toEqual([
            { sessionId: 'session-2', path: '/project/b.ts', isActiveRoot: true },
            { sessionId: 'session-2', path: '/worktree/a.ts', isActiveRoot: false },
        ]);
    });

    it('reports nothing before the Workbench is attached', () => {
        expect(
            listUnsavedEditorDocuments({ s: { '/a': document('/a') } }, undefined, (id) => id),
        ).toEqual([]);
    });
});

describe('unsavedEditorName', () => {
    it('uses the file name, never the full path', () => {
        expect(unsavedEditorName('/project/src/greeting.ts')).toBe('greeting.ts');
    });
});

describe('unsavedEditorNames', () => {
    it('adds the parent folder only to names two unsaved files share, including unlisted ones', () => {
        expect(
            unsavedEditorNames(
                ['/p/src/index.ts', '/p/README.md', '/p/lib/util.ts', '/p/lib/index.ts'],
                3,
            ),
        ).toEqual(['index.ts (src)', 'README.md', 'util.ts']);
    });
});

describe('unreachableUnsavedEditorsMessage', () => {
    it('names the files and the dialog choice, not quitting or closing', () => {
        expect(unreachableUnsavedEditorsMessage(['/p/notes.md'])).toBe(
            "notes.md belongs to a Workbench Root that is not open. Switch back to it to save, or choose Don't Save.",
        );
        expect(unreachableUnsavedEditorsMessage(['/p/a.md', '/p/b.md'])).toMatch(
            /^a\.md and b\.md belong to /u,
        );
        expect(
            unreachableUnsavedEditorsMessage([
                '/p/a.md',
                '/p/b.md',
                '/p/c.md',
                '/p/d.md',
                '/p/e.md',
            ]),
        ).toMatch(/^a\.md, b\.md, c\.md, and 2 more belong to /u);
    });
});

describe('subscribeUnsavedEditorRequests', () => {
    /**
     * Sends Main's request for one buffer kept under an inactive Workbench Root and resolves to the Renderer's reply.
     */
    async function answer(action: 'autoSave' | 'inspect' | 'saveAll'): Promise<unknown> {
        mocks.request.mockReset();
        mocks.request.mockResolvedValue(undefined);
        let listener: ((event: unknown) => void) | undefined;
        mocks.onEvent.mockImplementation((next) => {
            listener = next;
            return () => {};
        });
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-1',
                settings: {},
                sessions: [
                    { id: 'session-1', projectId: 'project', workbenchRootProjectId: 'project' },
                ],
            } as never,
        });
        useSessionViewStore.setState({
            documents: {
                'session-1\0project-worktree': { '/worktree/a.ts': document('/worktree/a.ts') },
            },
            recentDocuments: {},
        });
        const unsubscribe = subscribeUnsavedEditorRequests();
        listener?.({
            event: 'editor.unsavedRequest',
            payload: { requestId: 'request-1', action },
        });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
        unsubscribe();
        return mocks.request.mock.calls[0]?.[1];
    }

    it('leaves the inactive-root buffer to the prompt under auto save instead of toasting first', async () => {
        mocks.pushToast.mockClear();
        expect(await answer('autoSave')).toEqual({
            requestId: 'request-1',
            reply: { kind: 'saveFailed', reason: 'inactiveRoot' },
        });
        expect(mocks.pushToast).not.toHaveBeenCalled();
        expect(await answer('inspect')).toMatchObject({
            reply: { kind: 'summary', count: 1, names: ['a.ts'] },
        });
    });

    it('toasts the inactive-root buffer when the user chose Save', async () => {
        mocks.pushToast.mockClear();
        await answer('saveAll');
        expect(mocks.pushToast).toHaveBeenCalledWith(
            'error',
            unreachableUnsavedEditorsMessage(['/worktree/a.ts']),
        );
    });
});
