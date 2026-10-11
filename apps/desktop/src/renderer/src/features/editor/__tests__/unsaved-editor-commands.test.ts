import type { EditorDocument, SessionDocuments } from '@desktop-shared/editor-state';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn(), onEvent: vi.fn() } }));

import { listUnsavedEditorDocuments, unsavedEditorName } from '../unsaved-editor-commands';

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
