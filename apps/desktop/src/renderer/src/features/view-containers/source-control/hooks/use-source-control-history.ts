import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SourceControlHistoryDescriptor } from '@caxri/protocol';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { describeFailure } from '../../../../stores/toasts';
import { useSourceControlClient } from '../../controlled-view-context';
import { useIsViewContainerActive } from '../../view-container-activity';
import type { SourceControlHistoryItemsState } from '../source-control-history-state';
import { applySourceControlHistoryPage } from '../source-control-history-state';

export interface SourceControlHistoryScope {
    kind: 'file';
    path?: string;
}

export interface SourceControlHistoryExpansion {
    expanded: boolean;
    setExpanded: Dispatch<SetStateAction<boolean>>;
}

export function useSourceControlHistory(
    descriptor: SourceControlHistoryDescriptor,
    scope?: SourceControlHistoryScope,
    expansion?: SourceControlHistoryExpansion,
    isEnabled = true,
) {
    const client = useSourceControlClient();
    const [localExpanded, setLocalExpanded] = useState(false);
    const expanded = expansion?.expanded ?? localExpanded;
    const setExpanded = expansion?.setExpanded ?? setLocalExpanded;
    const [path, setPath] = useState('');
    const debouncedInputPath = useDebouncedValue(path, 200);
    const debouncedPath = scope?.kind === 'file' ? (scope.path ?? '') : debouncedInputPath;
    const [pageState, setPageState] = useState<SourceControlHistoryItemsState>({
        items: [],
        nextOffset: undefined,
        selectedId: undefined,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const activeRequest = useRef<AbortController | undefined>(undefined);
    const isContainerActive = useIsViewContainerActive();
    const scopePath = debouncedPath.trim() || undefined;
    const canLoad =
        isEnabled && isContainerActive && (scope?.kind !== 'file' || scopePath !== undefined);

    const loadPage = useCallback(
        async (offset: number, shouldReplace: boolean) => {
            activeRequest.current?.abort();
            const request = new AbortController();
            activeRequest.current = request;
            setLoading(true);
            setError(undefined);
            try {
                const page = await client.historyPage(
                    {
                        historyId: descriptor.id,
                        ...(descriptor.itemActivation && {
                            itemActivation: descriptor.itemActivation,
                        }),
                        offset,
                        pageSize: descriptor.pageSize,
                        revision: descriptor.revision!,
                        ...(scopePath && { path: scopePath }),
                    },
                    request.signal,
                );
                if (request !== activeRequest.current || page.revision !== descriptor.revision)
                    return;
                setPageState((current) =>
                    applySourceControlHistoryPage(current, page, shouldReplace),
                );
            } catch (error_) {
                if (request === activeRequest.current)
                    setError(describeFailure(error_, descriptor.loadErrorMessage));
            } finally {
                const isCurrentRequest = request === activeRequest.current;
                if (isCurrentRequest) activeRequest.current = undefined;
                setLoading((current) => (isCurrentRequest ? false : current));
            }
        },
        [client, descriptor, scopePath],
    );
    useEffect(() => {
        if (!canLoad || !expanded || !descriptor.revision) {
            activeRequest.current?.abort();
            activeRequest.current = undefined;
            return;
        }
        const timer = setTimeout(() => {
            // eslint-disable-next-line no-void -- loadPage owns its loading and error state
            void loadPage(0, true);
        }, 0);
        return () => {
            clearTimeout(timer);
            activeRequest.current?.abort();
            activeRequest.current = undefined;
        };
    }, [canLoad, descriptor.revision, expanded, loadPage]);
    const setSelectedId = useCallback<Dispatch<SetStateAction<string | undefined>>>((value) => {
        setPageState((current) => ({
            ...current,
            selectedId: typeof value === 'function' ? value(current.selectedId) : value,
        }));
    }, []);

    return {
        debouncedPath,
        error,
        expanded,
        items: pageState.items,
        loadPage,
        loading,
        nextOffset: pageState.nextOffset,
        path,
        scopePath,
        selectedId: pageState.selectedId,
        setExpanded,
        setPath,
        setSelectedId,
    };
}
