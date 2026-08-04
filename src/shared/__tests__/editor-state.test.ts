import { describe, expect, it } from 'vitest';

import {
    editorModelPath,
    markTabsClean,
    replaceWithExternalDocument,
    setSessionDocument,
    updateEditorTabState,
} from '../editor-state';
import type { SessionState } from '../types';

describe('external editor changes', () => {
    it('always replaces a dirty buffer with disk state', () => {
        const result = replaceWithExternalDocument({
            path: '/project/file.ts',
            content: 'external',
            mtimeMs: 2,
            size: 8,
        });
        expect(result).toEqual({
            path: '/project/file.ts',
            content: 'external',
            mtimeMs: 2,
            size: 8,
            dirty: false,
        });
    });

    it('clears reloaded tab dirtiness without reverting newer Session UI state', () => {
        const state: SessionState = {
            sessionId: 'session-1',
            openTabs: [
                { path: '/project/reloaded.ts', dirty: true },
                { path: '/project/other.ts', dirty: true },
            ],
            activeTab: '/project/other.ts',
            inspectorMode: 'agent',
            layout: { splitTerminalIds: ['terminal-1'] },
        };

        expect(markTabsClean(state, ['/project/reloaded.ts'])).toEqual({
            ...state,
            openTabs: [
                { path: '/project/reloaded.ts', dirty: false },
                { path: '/project/other.ts', dirty: true },
            ],
        });
    });
});

describe('Session editor state', () => {
    it('returns the same Session state when tab dirtiness and selection are unchanged', () => {
        const state: SessionState = {
            sessionId: 'session-1',
            openTabs: [{ path: '/project/file.ts', dirty: true }],
            activeTab: '/project/file.ts',
            inspectorMode: 'files',
            layout: { splitTerminalIds: [] },
        };

        expect(updateEditorTabState(state, '/project/file.ts', true)).toBe(state);
    });

    it('stores buffers independently when Sessions share the same root path', () => {
        const first = setSessionDocument({}, 'session-1', {
            path: '/project/file.ts',
            content: 'session one',
            dirty: true,
            mtimeMs: 1,
            size: 11,
        });
        const second = setSessionDocument(first, 'session-2', {
            path: '/project/file.ts',
            content: 'disk state',
            dirty: false,
            mtimeMs: 2,
            size: 10,
        });

        expect(second['session-1']['/project/file.ts'].content).toBe('session one');
        expect(second['session-2']['/project/file.ts'].content).toBe('disk state');
        expect(editorModelPath('session-1', '/project/file.ts')).not.toBe(
            editorModelPath('session-2', '/project/file.ts'),
        );
    });
});
