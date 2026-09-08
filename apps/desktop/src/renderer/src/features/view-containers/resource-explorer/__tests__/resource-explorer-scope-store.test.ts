import { beforeEach, describe, expect, it } from 'vitest';

import { controlledViewQueryKey } from '../../view-operation-client';
import {
    clearStaleScopeFocusPath,
    collapseScope,
    setScopeFocusPath,
    setScopePathExpanded,
    setScopeSelectedPath,
    setScopeSubtreeExpanded,
    useResourceExplorerScopeStore,
} from '../resource-explorer-scope-store';
import { scopedValue } from '../resource-explorer-state';

const scopeA = 'session-a:project-a';
const scopeB = 'session-b:project-a';

/**
 * Mirrors the per-row selectors used by `FileTreeItem`; a row only re-renders when its own boolean flips.
 */
function isExpanded(scopeId: string, path: string): boolean {
    const state = useResourceExplorerScopeStore.getState();
    return scopedValue(state.expandedByScope, scopeId)?.includes(path) ?? false;
}

describe('Resource Explorer scope store', () => {
    beforeEach(() => {
        useResourceExplorerScopeStore.setState({
            expandedByScope: {},
            focusByScope: {},
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
});
