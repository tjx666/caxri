import type { EditorDocument } from '@desktop-shared/editor-state';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    createSaveFailureTracker,
    saveFailureKey,
    subscribeSaveFailureCleanup,
} from '../save-failure-tracker';

describe('createSaveFailureTracker', () => {
    it('reports a repeated auto save failure for one file and reason only once', () => {
        const tracker = createSaveFailureTracker();
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(false);
    });

    it('reports a different file and a different reason separately', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        expect(tracker.shouldReport('s\0b.ts', 'Read-only.')).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Disk full.')).toBe(true);
    });

    it('reports again after a successful save clears the file', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        tracker.clear('s\0a.ts');
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(true);
    });

    it('always reports a manual save and keeps it as the last reported failure', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.', { force: true })).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(false);
    });
});

describe('subscribeSaveFailureCleanup', () => {
    const unsaved = (path: string, isDirty = true): EditorDocument => ({
        path,
        content: 'draft',
        mtimeMs: 1,
        size: 5,
        dirty: isDirty,
    });

    beforeEach(() => {
        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('reports the first failure again after the document is closed and reopened', () => {
        const tracker = createSaveFailureTracker();
        const unsubscribe = subscribeSaveFailureCleanup(tracker);
        const key = saveFailureKey('s', '/a.ts');
        const store = useSessionViewStore.getState();
        store.cacheDocument('s', unsaved('/a.ts'));
        tracker.shouldReport(key, 'Read-only.');

        store.cacheDocument('s', unsaved('/b.ts'));
        expect(tracker.shouldReport(key, 'Read-only.')).toBe(false);

        store.evictDocument('s', '/a.ts');
        store.cacheDocument('s', unsaved('/a.ts'));
        expect(tracker.shouldReport(key, 'Read-only.')).toBe(true);
        unsubscribe();
    });

    it('forgets a failure when a reload replaces the buffer with the clean copy on disk', () => {
        const tracker = createSaveFailureTracker();
        const unsubscribe = subscribeSaveFailureCleanup(tracker);
        const key = saveFailureKey('s', '/a.ts');
        const store = useSessionViewStore.getState();
        store.cacheDocument('s', unsaved('/a.ts'));
        tracker.shouldReport(key, 'Read-only.');

        store.cacheDocument('s', unsaved('/a.ts', false));
        store.cacheDocument('s', unsaved('/a.ts'));
        expect(tracker.shouldReport(key, 'Read-only.')).toBe(true);
        unsubscribe();
    });
});
