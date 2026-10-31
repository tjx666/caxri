import type { AgentChatVersionContent, AgentChatVersionSummary } from '@caxri/protocol';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey } from '../../../queries/client';

/**
 * The Chat's earlier versions, read per history: every rewind gives the snapshot a new `historyId`, so keying the read
 * on it fetches the list again exactly when a version may have been added.
 */
export function agentChatVersionsQuery(terminalId: string, historyId: string | undefined) {
    return {
        queryKey: [...caxriQueryKey('agentChat.listVersions', { terminalId }), historyId] as const,
        queryFn: (): Promise<AgentChatVersionSummary[]> =>
            caxri.request('agentChat.listVersions', { terminalId }),
        staleTime: Infinity,
    };
}

/**
 * One earlier version's content, which never changes once kept.
 */
export function agentChatVersionQuery(terminalId: string, versionId: string) {
    return {
        queryKey: caxriQueryKey('agentChat.readVersion', { terminalId, versionId }),
        queryFn: (): Promise<AgentChatVersionContent> =>
            caxri.request('agentChat.readVersion', { terminalId, versionId }),
        staleTime: Infinity,
    };
}
