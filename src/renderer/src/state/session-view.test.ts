import { beforeEach, describe, expect, it } from 'vitest';

import type { EditorDocument } from '@shared/editor-state';

import {
    MAX_CACHED_DOCUMENT_BYTES_GLOBAL,
    MAX_CACHED_DOCUMENTS_PER_SESSION,
    useSessionViewStore,
} from './session-view';

const document = (path: string, dirty = false): EditorDocument => ({
    path,
    content: path,
    mtimeMs: 1,
    size: path.length,
    dirty,
});

const cachedPaths = (sessionId: string): string[] =>
    Object.keys(useSessionViewStore.getState().documents[sessionId] ?? {});

describe('Session document cache', () => {
    beforeEach(() => {
        useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
    });

    it('releases a document when its tab is closed', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/a.ts'));
        store.cacheDocument('session-1', document('/b.ts'));

        store.evictDocument('session-1', '/a.ts');

        expect(cachedPaths('session-1')).toEqual(['/b.ts']);
    });

    it('evicts the least recently used clean documents beyond the cap', () => {
        const store = useSessionViewStore.getState();
        const total = MAX_CACHED_DOCUMENTS_PER_SESSION + 3;
        for (let index = 0; index < total; index += 1)
            store.cacheDocument('session-1', document(`/file-${index}.ts`));

        const paths = cachedPaths('session-1');
        expect(paths).toHaveLength(MAX_CACHED_DOCUMENTS_PER_SESSION);
        expect(paths).not.toContain('/file-0.ts');
        expect(paths).not.toContain('/file-2.ts');
        expect(paths).toContain(`/file-${total - 1}.ts`);
    });

    it('never evicts a dirty buffer, because that would lose unsaved edits', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/unsaved.ts', true));
        for (let index = 0; index < MAX_CACHED_DOCUMENTS_PER_SESSION + 3; index += 1)
            store.cacheDocument('session-1', document(`/file-${index}.ts`));

        expect(cachedPaths('session-1')).toContain('/unsaved.ts');
    });

    it('bounds retained clean document bytes across Sessions', () => {
        const store = useSessionViewStore.getState();
        const large = MAX_CACHED_DOCUMENT_BYTES_GLOBAL / 2 + 1;
        store.cacheDocument('session-1', { ...document('/first.ts'), size: large });
        store.cacheDocument('session-2', { ...document('/second.ts'), size: large });

        expect(cachedPaths('session-1')).toEqual([]);
        expect(cachedPaths('session-2')).toEqual(['/second.ts']);
    });

    it('evicts clean buffers before allowing unsaved work to exceed the byte budget', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', {
            ...document('/unsaved.ts', true),
            size: MAX_CACHED_DOCUMENT_BYTES_GLOBAL + 1,
        });
        store.cacheDocument('session-2', document('/clean.ts'));

        expect(cachedPaths('session-1')).toEqual(['/unsaved.ts']);
        expect(cachedPaths('session-2')).toEqual([]);
    });

    it('keeps caches of different Sessions independent and drops them on deletion', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/shared.ts'));
        store.cacheDocument('session-2', document('/shared.ts'));
        store.updateDocumentContent('session-1', '/shared.ts', 'first Session buffer');

        expect(useSessionViewStore.getState().documents['session-2']['/shared.ts'].content).toBe(
            '/shared.ts',
        );

        store.dropSessions(['session-1']);

        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
        expect(cachedPaths('session-2')).toEqual(['/shared.ts']);
    });
});
