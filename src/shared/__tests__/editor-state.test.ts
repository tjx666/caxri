import { describe, expect, it } from 'vitest';

import {
    editorTabPathsToClose,
    editorModelPath,
    markTabsClean,
    openEditorTabState,
    pinEditorTabState,
    replaceWithExternalDocument,
    setSessionDocument,
    updateEditorTabState,
} from '../editor-state';
import { createTerminalLayout } from '../terminal-layout';
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
            workbenchProjectId: 'project-1',
            openTabs: [
                { path: '/project/reloaded.ts', dirty: true },
                { path: '/project/other.ts', dirty: true },
            ],
            activeTab: { kind: 'editor', path: '/project/other.ts' },
            inspectorMode: 'info',
            layout: createTerminalLayout('terminal-1', () => 'group-1'),
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
    it('replaces only the current clean preview and preserves pinned tabs', () => {
        const state: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            openTabs: [
                { path: '/project/pinned.ts', dirty: false },
                { path: '/project/preview.ts', dirty: false, preview: true },
            ],
            activeTab: { kind: 'editor', path: '/project/preview.ts' },
            inspectorMode: 'files',
            layout: {},
        };

        expect(openEditorTabState(state, '/project/next.ts', true)).toEqual({
            replacedPath: '/project/preview.ts',
            state: {
                ...state,
                openTabs: [
                    { path: '/project/pinned.ts', dirty: false },
                    { path: '/project/next.ts', dirty: false, preview: true },
                ],
            },
        });
        expect(openEditorTabState(state, '/project/pinned.ts', true)).toEqual({ state });
    });

    it('pins previews explicitly and as soon as they become dirty', () => {
        const state: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            openTabs: [{ path: '/project/file.ts', dirty: false, preview: true }],
            activeTab: { kind: 'editor', path: '/project/file.ts' },
            inspectorMode: 'files',
            layout: {},
        };

        expect(pinEditorTabState(state, '/project/file.ts').openTabs).toEqual([
            { path: '/project/file.ts', dirty: false },
        ]);
        expect(updateEditorTabState(state, '/project/file.ts', true).openTabs).toEqual([
            { path: '/project/file.ts', dirty: true },
        ]);
    });

    it('selects the standard close-family tab sets without including Terminals', () => {
        const tabs: SessionState['openTabs'] = ['a', 'b', 'c'].map((path) => ({
            path,
            dirty: false,
        }));

        expect(editorTabPathsToClose(tabs, 'b', 'one')).toEqual(['b']);
        expect(editorTabPathsToClose(tabs, 'b', 'others')).toEqual(['a', 'c']);
        expect(editorTabPathsToClose(tabs, 'b', 'right')).toEqual(['c']);
        expect(editorTabPathsToClose(tabs, 'b', 'all')).toEqual(['a', 'b', 'c']);
    });

    it('returns the same Session state when tab dirtiness is unchanged', () => {
        const state: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            openTabs: [{ path: '/project/file.ts', dirty: true }],
            activeTab: { kind: 'editor', path: '/project/file.ts' },
            inspectorMode: 'files',
            layout: {},
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

    it('escapes URI delimiters in Monaco model paths without collapsing filesystem segments', () => {
        const modelPath = editorModelPath('session/1', '/project/a#b?c%2F.ts');

        expect(modelPath).toBe('caxri://session/session%2F1/project/a%23b%3Fc%252F.ts');
        expect(modelPath).not.toBe(editorModelPath('session/1', '/project/a/b.ts'));
    });
});
