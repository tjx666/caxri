import { useEffect, useMemo, useRef, useState } from 'react';

import type { MethodResult } from '@caxri/protocol';
import type { QueryObserverResult } from '@tanstack/react-query';
import { useQueries, useQueryClient } from '@tanstack/react-query';

import { translate } from '../../../../i18n';
import { shouldToastQueryError } from '../../../../queries/client';
import { describeFailure, pushToast } from '../../../../stores/toasts';
import { useResourceExplorerClient } from '../../controlled-view-context';
import {
    cancelViewContainerQuery,
    isViewContainerQueryEnabled,
    useIsViewContainerActive,
} from '../../view-container-activity';
import { controlledViewQueryKey } from '../../view-operation-client';
import type { FileTreeRow } from '../file-tree-rows';
import { flattenFileTree } from '../file-tree-rows';
import { useResourceExplorerScopeStore } from '../resource-explorer-scope-store';
import { scopedValue } from '../resource-explorer-state';

type FileListing = MethodResult<'files.list'>;

interface DirectoryListingState {
    data: FileListing | undefined;
    error: Error | null;
    isError: boolean;
}

const NO_PATHS: readonly string[] = [];

/**
 * Module-level so React Query sees one stable `combine` and re-runs it only when a listing actually changes; an inline
 * closure would hand the tree a new array on every render and defeat the row memo below.
 */
function combineListings(
    results: ReadonlyArray<QueryObserverResult<FileListing>>,
): DirectoryListingState[] {
    return results.map(({ data, error, isError }) => ({ data, error, isError }));
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Loads every directory the expanded Files tree shows and flattens them into the virtualized row model.
 *
 * Each directory keeps its own `files.list` query under the same key the nested components used, so recursive
 * expansion, file-operation reconciliation, and Refresh keep addressing listings exactly as before. Listings stay
 * cached per Project rather than per Session: every Session of a Project shares one root, so a Session switch reuses
 * the loaded tree. Hidden keep-alive panels keep that cache on screen and pause the listings until Files is selected
 * again.
 *
 * Which directories to request depends on the listings already loaded: a folder is only requested once its parent
 * listing contains it, so the requested set converges one level per render pass, all before commit.
 */
export function useFileTreeRows({
    composingDirectory,
    projectId,
    root,
}: {
    composingDirectory: string | undefined;
    projectId: string;
    root: string;
}): FileTreeRow[] {
    const client = useResourceExplorerClient();
    const queryClient = useQueryClient();
    const isContainerActive = useIsViewContainerActive();
    const expanded = useResourceExplorerScopeStore((state) => {
        const scopeId = state.activeScope?.scopeId;
        return scopeId === undefined
            ? NO_PATHS
            : (scopedValue(state.expandedByScope, scopeId) ?? NO_PATHS);
    });
    const [directories, setDirectories] = useState<readonly string[]>([root]);
    const queryKeys = useMemo(
        () =>
            directories.map((directory) =>
                controlledViewQueryKey(client.viewId, 'files.list', { directory }, projectId),
            ),
        [client.viewId, directories, projectId],
    );
    const listings = useQueries({
        queries: directories.map((directory, index) => ({
            queryKey: queryKeys[index],
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                client.listDirectory(directory, signal),
            enabled: isViewContainerQueryEnabled(isContainerActive),
        })),
        combine: combineListings,
    });

    const flattened = useMemo(() => {
        const listingByDirectory = new Map(
            directories.map((directory, index) => [directory, listings.at(index)?.data]),
        );
        const expandedPaths = new Set(expanded);
        return flattenFileTree({
            composingDirectory,
            isExpanded: (path) => expandedPaths.has(path),
            listing: (directory) => listingByDirectory.get(directory),
            root,
        });
    }, [composingDirectory, directories, expanded, listings, root]);

    // Adjusting state from the render that discovered it, React's documented alternative to an effect: the extra pass
    // runs before commit, so an expansion whose listing is already cached draws in the same frame.
    if (!isSameList(flattened.directories, directories)) setDirectories(flattened.directories);

    // `enabled: false` only blocks new fetches; a panel hidden mid-request cancels what is already in flight.
    useEffect(() => {
        if (isContainerActive) return;
        for (const queryKey of queryKeys) void cancelViewContainerQuery(queryClient, queryKey);
    }, [isContainerActive, queryClient, queryKeys]);

    // One toast per failure, the same contract `useToastOnQueryError` gives a single query.
    const toastedErrors = useRef(new WeakSet<Error>());
    useEffect(() => {
        for (const { error, isError } of listings) {
            if (
                !error ||
                !shouldToastQueryError(isError, error) ||
                toastedErrors.current.has(error)
            )
                continue;
            toastedErrors.current.add(error);
            pushToast(
                'error',
                describeFailure(
                    error,
                    translate('viewContainers.files.readDirectoryFailed'),
                    translate,
                ),
            );
        }
    }, [listings]);

    return flattened.rows;
}
