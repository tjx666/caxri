import { useMemo } from 'react';

import type { AgentDelegationSession } from '@caxri/protocol';

import { useTerminal } from '../../../../stores/selectors';
import { collapseRetryChains, delegationAttemptNumbers } from '../../../delegation/delegation-feed';
import { useDelegationFeed } from '../../../delegation/hooks/use-delegation-feed';
import { sortDelegatedSessions } from '../agent-chat-delegated-sessions';
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
    entries: readonly AgentDelegationSession[];
    /**
     * The Chat's own Session, whose delegated spend the strip header states.
     */
    sessionId: string | undefined;
}

/**
 * The Sessions this Chat's Agent delegated to, consulted, or handed off to, one entry per child Session in the order a
 * person should look at them. Reads `agent.delegation.sessions` for this Chat's own Session through the same cache
 * entries and invalidation as the sidebar's nested rows. Asks nothing where the window cannot show them.
 */
export function useDelegatedSessions(terminalId: string): DelegatedSessions {
    const canShow = useCanShowDelegatedSessions();
    const sessionId = useTerminal(terminalId)?.sessionId;
    const chunks = useMemo(() => (sessionId ? [[sessionId]] : []), [sessionId]);
    const { entries } = useDelegationFeed(chunks, { isEnabled: canShow });
    return useMemo(() => {
        // One row per chain of retries: a failure a retry superseded gives way to the newest attempt.
        const shown = collapseRetryChains(entries);
        return {
            attempts: delegationAttemptNumbers(entries),
            chainSessionIds: new Map(
                shown.map((entry) => [entry.sessionId, retryChainSessionIds(entry, entries)]),
            ),
            entries: sortDelegatedSessions(shown),
            sessionId,
        };
    }, [entries, sessionId]);
}
