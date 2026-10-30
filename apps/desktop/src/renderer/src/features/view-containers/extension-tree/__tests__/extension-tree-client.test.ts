import type { TreeItemDto } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import { createCaxriQueryClient, EXTENSION_TREE_GC_TIME_MS } from '../../../../queries/client';
import type { ExtensionTreeScope } from '../extension-tree-client';
import {
    cacheTreeChildren,
    clearCachedTreeChildren,
    readCachedTreeChildren,
    removeCachedTreeChildren,
    ROOT_HANDLE,
} from '../extension-tree-client';

const scope: ExtensionTreeScope = {
    extensionGeneration: 1,
    sessionId: 'session-1',
    viewId: 'publisher.extension.status',
    workbenchRootProjectId: 'project-1',
};

function item(handle: string): TreeItemDto {
    return { accessibilityLabel: handle, handle, label: handle, collapsibleState: 'collapsed' };
}

describe('extension tree branch cache', () => {
    it('restores the branches a Session loaded before it was switched away from', () => {
        const queryClient = new QueryClient();
        cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [item('repository')]);
        cacheTreeChildren(queryClient, scope, 'repository', [item('checks')]);

        expect(readCachedTreeChildren(queryClient, scope)).toEqual(
            new Map([
                [ROOT_HANDLE, [item('repository')]],
                ['repository', [item('checks')]],
            ]),
        );
    });

    it('keeps another Session, Project, or View out of the restored branches', () => {
        const queryClient = new QueryClient();
        cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [item('own')]);
        cacheTreeChildren(queryClient, { ...scope, sessionId: 'session-2' }, ROOT_HANDLE, [
            item('other-session'),
        ]);
        cacheTreeChildren(
            queryClient,
            { ...scope, workbenchRootProjectId: 'project-2' },
            ROOT_HANDLE,
            [item('other-project')],
        );
        cacheTreeChildren(
            queryClient,
            { ...scope, viewId: 'publisher.extension.other' },
            ROOT_HANDLE,
            [item('other-view')],
        );

        expect(readCachedTreeChildren(queryClient, scope)).toEqual(
            new Map([[ROOT_HANDLE, [item('own')]]]),
        );
    });

    it('starts empty after an Extension reload retires every handle it issued', () => {
        const queryClient = new QueryClient();
        cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [item('repository')]);

        expect(readCachedTreeChildren(queryClient, { ...scope, extensionGeneration: 2 }).size).toBe(
            0,
        );
    });

    it('drops only the handles a refresh retired', () => {
        const queryClient = new QueryClient();
        cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [item('repository')]);
        cacheTreeChildren(queryClient, scope, 'repository', [item('checks')]);
        cacheTreeChildren(queryClient, scope, 'checks', [item('build')]);

        removeCachedTreeChildren(queryClient, scope, ['checks']);

        expect(readCachedTreeChildren(queryClient, scope).keys().toArray()).toEqual([
            ROOT_HANDLE,
            'repository',
        ]);
    });

    it('clears one View without disturbing another Session', () => {
        const queryClient = new QueryClient();
        const otherSession = { ...scope, sessionId: 'session-2' };
        cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [item('own')]);
        cacheTreeChildren(queryClient, otherSession, ROOT_HANDLE, [item('other-session')]);

        clearCachedTreeChildren(queryClient, scope);

        expect(readCachedTreeChildren(queryClient, scope).size).toBe(0);
        expect(readCachedTreeChildren(queryClient, otherSession).size).toBe(1);
    });

    /**
     * A branch written with `setQueryData` has no observer while its View is unmounted, so the default
     * garbage-collection window is what decides whether switching back to a Session still finds it. Five minutes is
     * short enough to lose an ordinary round trip between two Sessions, which is the defect this cache exists to fix.
     */
    it('outlives an unmounted View long enough to switch Sessions and come back', () => {
        expect(
            createCaxriQueryClient().getQueryDefaults(['viewContainers.treeChildren']).gcTime,
        ).toBe(EXTENSION_TREE_GC_TIME_MS);
        expect(EXTENSION_TREE_GC_TIME_MS).toBeGreaterThan(5 * 60_000);
    });
});
