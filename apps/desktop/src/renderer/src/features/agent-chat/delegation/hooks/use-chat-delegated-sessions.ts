import { useMemo } from 'react';

import type { AgentDelegationSession } from '@caxri/protocol';
import { collapseRetryChains } from '@caxri/protocol';
import { keepPreviousData } from '@tanstack/react-query';

import { useCaxriQuery } from '../../../../queries/client';
import { useTerminal } from '../../../../stores/selectors';
import { delegationAttemptNumbers } from '../../../delegation/delegation-feed';
import { useDelegationFeed } from '../../../delegation/hooks/use-delegation-feed';
import { mergeDeeperAttention } from '../agent-chat-delegated-sessions';
import { retryChainSessionIds } from '../cost/agent-chat-delegated-cost';
import { useCanShowDelegatedSessions } from './use-can-show-delegated-sessions';

export interface DelegatedSessions {
    /**
     * The attempt number of each retried task, by task ID (`delegationAttemptNumbers`).
     */
    attempts: ReadonlyMap<string, number>;
    /**
     * The Sessions each shown row's retry chain ran in (`retryChainSessionIds`), by the row's Session ID, so a row's
     * spend includes the attempts it replaced.
     */
    chainSessionIds: ReadonlyMap<string, readonly string[]>;
    /**
     * Every row, in the order a person should look at them: the direct children plus the deeper Sessions that need the
     * user.
     */
    entries: readonly AgentDelegationSession[];
    /**
     * True when the Server could not read or list every deeper item, so the header must not read as complete.
     */
    isPartial: boolean;
    /**
     * The Chat's own Session, whose delegated spend the strip header states.
     */
    sessionId: string | undefined;
    /**
     * How many children the Chat created itself; the header's "delegated" figure. Deeper rows are not in it.
     */
    total: number;
    /**
     * The direct child a deeper row sits under, by the row's Session ID; a direct child is absent.
     */
    viaBySessionId: ReadonlyMap<string, string>;
}

/**
 * The roll-up has no poll: `invalidation-delegation-feed.ts` refreshes it, and this window is the backstop for a change
 * the window could not hear.
 */
const DELEGATION_ATTENTION_STALE_TIME_MS = 60_000;

/**
 * The Sessions this Chat's Agent delegated to, consulted, or handed off to, one entry per child Session in the order a
 * person should look at them, plus the deeper Sessions that need the user (`agent.delegation.attention`). Reads
 * `agent.delegation.sessions` for this Chat's own Session through the same cache entries and invalidation as the
 * sidebar's nested rows. Asks nothing where the window cannot show them.
 */
export function useChatDelegatedSessions(terminalId: string): DelegatedSessions {
    const canShow = useCanShowDelegatedSessions();
    const sessionId = useTerminal(terminalId)?.sessionId;
    const chunks = useMemo(() => (sessionId ? [[sessionId]] : []), [sessionId]);
    const { entries } = useDelegationFeed(chunks, { isEnabled: canShow });
    const { data: attention } = useCaxriQuery(
        'agent.delegation.attention',
        { sessionId: sessionId ?? '' },
        {
            // Only a Chat that has direct children can have deeper ones.
            enabled: canShow && sessionId !== undefined && entries.length > 0,
            placeholderData: keepPreviousData,
            staleTime: DELEGATION_ATTENTION_STALE_TIME_MS,
        },
    );
    return useMemo(() => {
        // One row per chain of retries: a failure a retry superseded gives way to the newest attempt.
        const shown = collapseRetryChains(entries);
        const rows = mergeDeeperAttention(shown, attention);
        return {
            attempts: delegationAttemptNumbers(entries),
            chainSessionIds: new Map(
                shown.map((entry) => [entry.sessionId, retryChainSessionIds(entry, entries)]),
            ),
            entries: rows.entries,
            isPartial: rows.isPartial,
            sessionId,
            total: shown.length,
            viaBySessionId: rows.viaBySessionId,
        };
    }, [attention, entries, sessionId]);
}
