import { useEffect } from 'react';

import { keepPreviousData } from '@tanstack/react-query';

import { useCaxriQuery } from '../../../queries/client';

/**
 * The Chat's snapshot and its context report for the Context tab. The report is re-read whenever the snapshot's token
 * total moves, that is after every model response, so an open tab follows a running turn without polling an idle one.
 * The previous report stays on screen while the next one loads.
 */
export function useAgentContextReport(terminalId: string) {
    const chat = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const report = useCaxriQuery(
        'agentChat.readContext',
        { terminalId },
        { staleTime: Infinity, retry: false, placeholderData: keepPreviousData },
    );
    const totalTokens = chat.data?.usage?.totalTokens;
    const { refetch } = report;
    useEffect(() => {
        if (totalTokens === undefined) return;
        // A read already in flight answers for this total too, so it is joined instead of restarted.
        void refetch({ cancelRefetch: false });
    }, [totalTokens, refetch]);
    return { chat, report };
}
