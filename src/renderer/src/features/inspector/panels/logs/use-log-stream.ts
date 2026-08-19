import { useState } from 'react';

import type { LogProcess, LogQueryRecord, LogQueryResult } from '@shared/types';

import { usePolledQuery } from '../../../../hooks/use-polled-query';
import { appendLogPage, clearLogStream, emptyLogStream } from './log-stream';

export interface LogStream {
    records: LogQueryRecord[];
    /**
     * True once the server reported that records rotated out between polls, so the view is missing history.
     */
    gap: boolean;
    isLoading: boolean;
    clear(): void;
}

const PAGE_LIMIT = 100;
const POLL_INTERVAL_MS = 1_000;

/**
 * Cursor-following accumulation over `logs.query`: the first fetch loads the latest page, then every poll resumes from
 * the server cursor so records append instead of replacing. Changing the process filter restarts the stream from the
 * latest page for that process. Advancing the cursor changes the query key, so a backlog drains in immediate
 * back-to-back fetches before settling to the poll cadence.
 *
 * Pages fold into state during render (the React "adjust state when a prop changes" pattern, not an effect); this is
 * idempotent because `appendLogPage` deduplicates by record id and returns the identical state for a no-op, and
 * react-query's structural sharing keeps `query.data` referentially stable across idle polls.
 */
export function useLogStream(process: LogProcess | undefined): LogStream {
    const [state, setState] = useState(emptyLogStream);
    const [streamedProcess, setStreamedProcess] = useState(process);
    const [foldedPage, setFoldedPage] = useState<LogQueryResult>();

    if (streamedProcess !== process) {
        setStreamedProcess(process);
        setFoldedPage(undefined);
        setState(emptyLogStream);
    }

    const query = usePolledQuery(
        'logs.query',
        {
            limit: PAGE_LIMIT,
            ...(process && { process }),
            ...(state.cursor && { afterCursor: state.cursor }),
        },
        { label: 'inspector.logs', intervalMs: POLL_INTERVAL_MS },
    );

    const page = query.data;
    if (page && page !== foldedPage && streamedProcess === process) {
        setFoldedPage(page);
        setState((current) => appendLogPage(current, page));
    }

    return {
        records: state.records,
        gap: state.gap,
        isLoading: state.records.length === 0 && query.isPending,
        clear: () => setState(clearLogStream),
    };
}
