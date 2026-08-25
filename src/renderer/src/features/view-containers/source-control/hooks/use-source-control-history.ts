import { useCallback, useEffect, useRef, useState } from 'react';

import type { SourceControlHistoryDescriptor, SourceControlHistoryPage } from '@shared/views';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { describeFailure } from '../../../../stores/toasts';
import { useSourceControlClient } from '../../controlled-view-context';

type SourceControlHistoryItem = SourceControlHistoryPage['items'][number];

export function useSourceControlHistory(descriptor: SourceControlHistoryDescriptor) {
    const client = useSourceControlClient();
    const [expanded, setExpanded] = useState(false);
    const [path, setPath] = useState('');
    const debouncedPath = useDebouncedValue(path, 200);
    const [items, setItems] = useState<SourceControlHistoryItem[]>([]);
    const [nextOffset, setNextOffset] = useState<number>();
    const [selectedId, setSelectedId] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const activeRequest = useRef<AbortController | undefined>(undefined);
    const scopePath = debouncedPath.trim() || undefined;

    const loadPage = useCallback(
        async (offset: number, shouldReplace: boolean) => {
            activeRequest.current?.abort();
            const request = new AbortController();
            activeRequest.current = request;
            setLoading(true);
            if (shouldReplace) {
                setItems([]);
                setSelectedId(undefined);
            }
            setError(undefined);
            try {
                const page = await client.historyPage(
                    {
                        historyId: descriptor.id,
                        offset,
                        pageSize: descriptor.pageSize,
                        revision: descriptor.revision!,
                        ...(scopePath && { path: scopePath }),
                    },
                    request.signal,
                );
                if (request !== activeRequest.current || page.revision !== descriptor.revision)
                    return;
                setItems((current) => (shouldReplace ? page.items : [...current, ...page.items]));
                setNextOffset(page.nextOffset);
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
        if (!expanded || !descriptor.revision) {
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
    }, [descriptor.revision, expanded, loadPage]);

    return {
        debouncedPath,
        error,
        expanded,
        items,
        loadPage,
        loading,
        nextOffset,
        path,
        scopePath,
        selectedId,
        setExpanded,
        setPath,
        setSelectedId,
    };
}
