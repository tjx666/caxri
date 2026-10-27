import type { BootstrapState } from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkbenchStore } from '../../../../stores/workbench';
import { controlledViewQueryKey } from '../../view-operation-client';
import {
    activeResourceExplorerScope,
    clearScopeRevealPath,
    clearStaleScopeFocusPath,
    collapseScope,
    didRevealDirectoryInScope,
    didRevealPathInScope,
    followEditorFileInScope,
    pruneResourceExplorerScopes,
    rowSelectors,
    setResourceExplorerActiveScope,
    setScopeFocusPath,
    setScopePathExpanded,
    setScopeSelectedPath,
    setScopeSubtreeExpanded,
    subscribeResourceExplorerScopePruning,
    useResourceExplorerScopeStore,
} from '../resource-explorer-scope-store';

const scopeA = 'session-a:project-a';
const scopeB = 'session-b:project-a';

/**
 * The real per-row selector `FileTreeItem` subscribes through, read against whichever scope is active; a row only
 * re-renders when its own boolean flips.
 */
function isExpanded(scopeId: string, path: string): boolean {
    setResourceExplorerActiveScope({
        projectId: 'project-a',
        scopeId,
        sessionId: scopeId.split(':', 1)[0],
    });
    return rowSelectors.isPathExpanded(useResourceExplorerScopeStore.getState(), path);
}

/**
 * Every input one row subscribes to, as one comparable tuple.
 */
function rowInputs(path: string): unknown[] {
    const state = useResourceExplorerScopeStore.getState();
    return [
        rowSelectors.isPathExpanded(state, path),
        rowSelectors.isPathSelected(state, path),
        rowSelectors.isPathFocusRequested(state, path),
        rowSelectors.hasScopeSelection(state),
    ];
}

function selectScope(scopeId: string): void {
    setResourceExplorerActiveScope({
        projectId: 'project-a',
        scopeId,
        sessionId: scopeId.slice(0, scopeId.indexOf(':')),
    });
}

describe('Resource Explorer scope store', () => {
    beforeEach(() => {
        useResourceExplorerScopeStore.setState({
            activeScope: undefined,
            expandedByScope: {},
            focusByScope: {},
            revealByScope: {},
            selectionByScope: {},
        });
    });

    it('keeps expansion and selection isolated per Session scope of the same Project', () => {
        setScopePathExpanded(scopeA, '/project/src', true);
        setScopeSelectedPath(scopeA, '/project/src/index.ts');

        expect(isExpanded(scopeA, '/project/src')).toBe(true);
        expect(isExpanded(scopeB, '/project/src')).toBe(false);
        expect(useResourceExplorerScopeStore.getState().selectionByScope[scopeB]).toBeUndefined();

        setScopePathExpanded(scopeA, '/project/src', (current) => !current);
        expect(isExpanded(scopeA, '/project/src')).toBe(false);
    });

    it('reveals a file by expanding its ancestors without collapsing unrelated folders', () => {
        setScopePathExpanded(scopeA, '/project/docs', true);

        expect(didRevealPathInScope(scopeA, '/project', '/project/src/components/button.tsx')).toBe(
            true,
        );

        expect(useResourceExplorerScopeStore.getState()).toMatchObject({
            expandedByScope: {
                [scopeA]: ['/project/docs', '/project/src', '/project/src/components'],
            },
            selectionByScope: {
                [scopeA]: '/project/src/components/button.tsx',
            },
            revealByScope: {
                [scopeA]: {
                    path: '/project/src/components/button.tsx',
                    revision: 1,
                },
            },
        });
        expect(isExpanded(scopeB, '/project/src')).toBe(false);
    });

    it('does not reveal a path outside the Project root', () => {
        const before = useResourceExplorerScopeStore.getState();

        expect(didRevealPathInScope(scopeA, '/project', '/project-other/file.ts')).toBe(false);
        expect(useResourceExplorerScopeStore.getState()).toBe(before);
    });

    it('clears only the reveal token a row actually consumed', () => {
        didRevealPathInScope(scopeA, '/project', '/project/src/index.ts');

        clearScopeRevealPath(scopeA, { path: '/project/src/index.ts', revision: 2 });
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toEqual({
            path: '/project/src/index.ts',
            revision: 1,
        });

        clearScopeRevealPath(scopeA, { path: '/project/src/index.ts', revision: 1 });
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toBeUndefined();
    });

    it('follows the Editor: reveals a Project file and drops a pending reveal for anything else', () => {
        followEditorFileInScope(scopeA, '/project', '/project/src/index.ts');
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toEqual({
            path: '/project/src/index.ts',
            revision: 1,
        });

        // A Terminal or diff tab, then an external file: neither may leave the previous file's reveal pending.
        followEditorFileInScope(scopeA, '/project', undefined);
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toBeUndefined();

        followEditorFileInScope(scopeA, '/project', '/project/src/index.ts');
        followEditorFileInScope(scopeA, '/project', '/elsewhere/notes.md');
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toBeUndefined();
        expect(useResourceExplorerScopeStore.getState().selectionByScope[scopeA]).toBe(
            '/project/src/index.ts',
        );
    });

    it('reveals a directory by selecting it and expanding it along with its ancestors', () => {
        expect(didRevealDirectoryInScope(scopeA, '/project', '/project/a/.config')).toBe(true);

        const state = useResourceExplorerScopeStore.getState();
        expect(state.selectionByScope[scopeA]).toBe('/project/a/.config');
        expect(state.revealByScope[scopeA]?.path).toBe('/project/a/.config');
        expect(state.expandedByScope[scopeA]).toEqual(
            expect.arrayContaining(['/project/a', '/project/a/.config']),
        );
    });

    it('has no row to reveal for the Project root or a path outside it', () => {
        expect(didRevealDirectoryInScope(scopeA, '/project', '/project')).toBe(false);
        expect(didRevealDirectoryInScope(scopeA, '/project', '/elsewhere/dir')).toBe(false);
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toBeUndefined();
    });

    it('keeps a reveal that was pending when the Files view first mounted', () => {
        didRevealDirectoryInScope(scopeA, '/project', '/project/.config');

        followEditorFileInScope(scopeA, '/project', undefined, { isInitial: true });
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]?.path).toBe(
            '/project/.config',
        );

        followEditorFileInScope(scopeA, '/project', undefined);
        expect(useResourceExplorerScopeStore.getState().revealByScope[scopeA]).toBeUndefined();
    });

    it('leaves unrelated scope entries referentially stable when one scope changes', () => {
        setScopePathExpanded(scopeB, '/project/docs', true);
        const before = useResourceExplorerScopeStore.getState().expandedByScope[scopeB];

        setScopePathExpanded(scopeA, '/project/src', true);
        collapseScope(scopeA);

        expect(useResourceExplorerScopeStore.getState().expandedByScope[scopeB]).toBe(before);
        expect(useResourceExplorerScopeStore.getState().expandedByScope[scopeA]).toEqual([]);
    });

    it('expands recursively only through directories the Project query cache already knows', async () => {
        const { queryClient } = await import('../../../../queries/client');
        const viewId = 'files-view';
        queryClient.setQueryData(
            controlledViewQueryKey(viewId, 'files.list', { directory: '/project' }, 'project-a'),
            { entries: [{ kind: 'directory', path: '/project/src' }] },
        );
        queryClient.setQueryData(
            controlledViewQueryKey(
                viewId,
                'files.list',
                { directory: '/project/src' },
                'project-a',
            ),
            { entries: [{ kind: 'directory', path: '/project/src/lib' }] },
        );

        setScopeSubtreeExpanded(scopeA, viewId, 'project-a', '/project', (current) => !current);

        expect(isExpanded(scopeA, '/project')).toBe(true);
        expect(isExpanded(scopeA, '/project/src')).toBe(true);
        // `/project/src/lib` has no cached listing, so it is never marked expanded.
        expect(isExpanded(scopeA, '/project/src/lib')).toBe(false);
        expect(isExpanded(scopeB, '/project')).toBe(false);
        queryClient.clear();
    });

    it('drops a stale focus request when another row receives real focus, without rewriting state otherwise', () => {
        setScopeFocusPath(scopeA, '/project/a.ts');
        const before = useResourceExplorerScopeStore.getState();

        clearStaleScopeFocusPath(scopeA, '/project/a.ts');
        expect(useResourceExplorerScopeStore.getState()).toBe(before);

        clearStaleScopeFocusPath(scopeA, '/project/b.ts');
        expect(useResourceExplorerScopeStore.getState().focusByScope[scopeA]).toBeUndefined();
    });

    it('drops the state of Sessions that no longer exist and keeps live scopes by reference', () => {
        setScopePathExpanded(scopeA, '/a/src', true);
        setScopeSelectedPath(scopeB, '/b/file.ts');
        setScopeFocusPath(scopeB, '/b/file.ts');
        const liveExpanded = useResourceExplorerScopeStore.getState().expandedByScope;

        pruneResourceExplorerScopes(new Set(['session-a']));

        const state = useResourceExplorerScopeStore.getState();
        expect(state.expandedByScope).toBe(liveExpanded);
        expect(state.selectionByScope).toEqual({});
        expect(state.focusByScope).toEqual({});
    });

    /**
     * The regression behind issue #784: switching Session used to re-render all 49 visible file-tree rows, because the
     * scope reached them as a prop. Rows now read it from here, so a switch may only disturb the rows whose own state
     * actually differs between the two Sessions.
     */
    it('leaves every row untouched when switching to a Session with the same tree state', () => {
        const paths = Array.from({ length: 49 }, (_, index) => `/project/file-${index}.ts`);
        for (const scopeId of [scopeA, scopeB]) {
            setScopePathExpanded(scopeId, '/project/src', true);
            setScopeSelectedPath(scopeId, '/project/file-7.ts');
        }

        selectScope(scopeA);
        const before = paths.map((path) => rowInputs(path));
        selectScope(scopeB);
        const after = paths.map((path) => rowInputs(path));

        expect(after).toEqual(before);
        expect(activeResourceExplorerScope()?.scopeId).toBe(scopeB);
    });

    it('disturbs only the rows whose state differs in the Session switched to', () => {
        const paths = ['/project/a.ts', '/project/b.ts', '/project/src'];
        setScopePathExpanded(scopeA, '/project/src', true);
        setScopeSelectedPath(scopeA, '/project/a.ts');
        // Scope B has the same selection but leaves `/project/src` collapsed.
        setScopeSelectedPath(scopeB, '/project/a.ts');

        selectScope(scopeA);
        const before = paths.map((path) => rowInputs(path));
        selectScope(scopeB);
        const after = paths.map((path) => rowInputs(path));

        const changed = paths.filter((_, index) => {
            return JSON.stringify(before[index]) !== JSON.stringify(after[index]);
        });
        expect(changed).toEqual(['/project/src']);
    });

    it('drops the active scope when its Session is pruned', () => {
        selectScope(scopeB);
        pruneResourceExplorerScopes(new Set(['session-a']));

        expect(activeResourceExplorerScope()).toBeUndefined();
    });

    it('prunes when the bootstrap Session list changes', () => {
        const unsubscribe = subscribeResourceExplorerScopePruning();
        setScopePathExpanded(scopeB, '/b/src', true);
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [{ id: 'session-a', workbenchRootProjectId: 'project-a' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        expect(useResourceExplorerScopeStore.getState().expandedByScope).toEqual({});
        unsubscribe();
    });
});
