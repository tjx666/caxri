import type { BootstrapState } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    getSessionDocuments,
    MAX_CACHED_DOCUMENT_BYTES_GLOBAL,
    MAX_CACHED_DOCUMENTS_PER_SESSION,
    sessionViewScope,
    useSessionViewStore,
} from './session-view';
import { useWorkbenchStore } from './workbench';

/**
 * `isDirty` maps to the shared `EditorDocument.dirty` field (defined outside the Renderer); the local parameter is
 * renamed for unicorn/consistent-boolean-name without touching that shared type.
 */
const document = (path: string, isDirty = false): EditorDocument => ({
    path,
    content: path,
    mtimeMs: 1,
    size: path.length,
    dirty: isDirty,
});

const cachedPaths = (sessionId: string): string[] =>
    Object.keys(useSessionViewStore.getState().documents[sessionId] ?? {});

describe('Session document cache', () => {
    beforeEach(() => {
        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        useWorkbenchStore.setState({ bootstrap: undefined });
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

    it('keeps recording an open untitled buffer after it outgrows the read-copy budget', () => {
        const store = useSessionViewStore.getState();
        const path = 'caxri-untitled://1';
        store.cacheDocument(
            'session-1',
            {
                path,
                content: '',
                mtimeMs: 0,
                size: 0,
                dirty: false,
                ephemeral: true,
            },
            'project-1',
        );
        const pasted = 'x'.repeat(MAX_CACHED_DOCUMENT_BYTES_GLOBAL / 2 + 1);

        store.updateDocumentContent('session-1', path, pasted, 'project-1');

        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: pasted,
            dirty: true,
        });
    });

    it('never evicts a dirty buffer, because that would lose unsaved edits', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/unsaved.ts', true));
        for (let index = 0; index < MAX_CACHED_DOCUMENTS_PER_SESSION + 3; index += 1)
            store.cacheDocument('session-1', document(`/file-${index}.ts`));

        expect(cachedPaths('session-1')).toContain('/unsaved.ts');
    });

    it('rejects ephemeral documents that exceed the count or protected byte budgets', () => {
        const store = useSessionViewStore.getState();
        expect(
            store.cacheDocument('session-1', {
                ...document('caxri-external-file://oversized/outside.ts'),
                ephemeral: true,
                readOnly: true,
                size: MAX_CACHED_DOCUMENT_BYTES_GLOBAL + 1,
            }),
        ).toBe(false);
        expect(cachedPaths('session-1')).toEqual([]);

        for (let index = 0; index < MAX_CACHED_DOCUMENTS_PER_SESSION; index += 1)
            expect(
                store.cacheDocument('session-1', {
                    ...document(`caxri-external-file://external-${index}/outside.ts`),
                    ephemeral: true,
                    readOnly: true,
                }),
            ).toBe(true);
        expect(
            store.cacheDocument('session-1', {
                ...document('caxri-external-file://overflow/outside.ts'),
                ephemeral: true,
                readOnly: true,
            }),
        ).toBe(false);
    });

    it('keeps admitted ephemeral documents cached while respecting the global budget', () => {
        const store = useSessionViewStore.getState();
        const large = MAX_CACHED_DOCUMENT_BYTES_GLOBAL / 2 + 1;
        expect(
            store.cacheDocument('session-1', {
                ...document('caxri-external-file://external-1/outside.ts'),
                ephemeral: true,
                readOnly: true,
                size: large,
            }),
        ).toBe(true);
        expect(
            store.cacheDocument('session-2', {
                ...document('caxri-external-file://external-2/outside.ts'),
                ephemeral: true,
                readOnly: true,
                size: large,
            }),
        ).toBe(false);
        for (let index = 0; index < MAX_CACHED_DOCUMENTS_PER_SESSION + 3; index += 1)
            store.cacheDocument('session-1', document(`/file-${index}.ts`));

        expect(cachedPaths('session-1')).toContain('caxri-external-file://external-1/outside.ts');
        expect(cachedPaths('session-2')).toEqual([]);
    });

    it('does not mutate a read-only document', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', {
            ...document('caxri-external-file://external-1/outside.ts'),
            content: 'original',
            readOnly: true,
        });

        store.updateDocumentContent(
            'session-1',
            'caxri-external-file://external-1/outside.ts',
            'changed',
            'project-1',
        );

        expect(
            useSessionViewStore.getState().documents['session-1'][
                'caxri-external-file://external-1/outside.ts'
            ],
        ).toMatchObject({ content: 'original', dirty: false });
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
        store.updateDocumentContent('session-1', '/shared.ts', 'first Session buffer', 'project-1');

        expect(useSessionViewStore.getState().documents['session-2']['/shared.ts'].content).toBe(
            '/shared.ts',
        );

        store.dropSessions(['session-1']);

        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
        expect(cachedPaths('session-2')).toEqual(['/shared.ts']);
    });

    it('isolates same-path dirty buffers by Session and Workbench Project', () => {
        const selectRoot = (workbenchProjectId: string): void =>
            useWorkbenchStore.setState({
                bootstrap: {
                    sessions: [
                        {
                            id: 'session-1',
                            projectId: 'project-owner',
                            workbenchProjectId,
                        },
                    ],
                } as unknown as BootstrapState,
            });
        selectRoot('project-owner');
        useSessionViewStore.getState().cacheDocument('session-1', {
            ...document('/shared/file.ts', true),
            content: 'owner draft',
        });

        selectRoot('project-worktree');
        useSessionViewStore.getState().cacheDocument('session-1', {
            ...document('/shared/file.ts', true),
            content: 'worktree draft',
        });

        expect(getSessionDocuments('session-1')?.['/shared/file.ts'].content).toBe(
            'worktree draft',
        );
        expect(getSessionDocuments('session-1', 'project-owner')?.['/shared/file.ts'].content).toBe(
            'owner draft',
        );
        expect(sessionViewScope('session-1', 'project-worktree')).toBe(
            'session-1\0project-worktree',
        );

        selectRoot('project-owner');
        expect(getSessionDocuments('session-1')?.['/shared/file.ts']).toMatchObject({
            content: 'owner draft',
            dirty: true,
        });
    });

    it('remaps descendant documents without losing dirty buffers', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/project/src/dirty.ts', true));
        store.cacheDocument('session-1', document('/project/src/nested/clean.ts'));
        store.cacheDocument('session-1', document('/project/other.ts'));

        store.remapDocuments('session-1', '/project/src', '/project/lib');

        expect(cachedPaths('session-1')).toEqual([
            '/project/lib/dirty.ts',
            '/project/lib/nested/clean.ts',
            '/project/other.ts',
        ]);
        expect(
            useSessionViewStore.getState().documents['session-1']['/project/lib/dirty.ts'],
        ).toMatchObject({ path: '/project/lib/dirty.ts', dirty: true });
    });

    it('evicts only documents at or below a trashed path', () => {
        const store = useSessionViewStore.getState();
        store.cacheDocument('session-1', document('/project/src/a.ts', true));
        store.cacheDocument('session-1', document('/project/src/nested/b.ts'));
        store.cacheDocument('session-1', document('/project/src-other/c.ts'));

        store.evictDocumentsUnderPath('session-1', '/project/src');

        expect(cachedPaths('session-1')).toEqual(['/project/src-other/c.ts']);
    });
});
