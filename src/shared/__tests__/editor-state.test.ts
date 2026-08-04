import { describe, expect, it } from 'vitest';

import { markTabsClean, replaceWithExternalDocument } from '../editor-state';
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
