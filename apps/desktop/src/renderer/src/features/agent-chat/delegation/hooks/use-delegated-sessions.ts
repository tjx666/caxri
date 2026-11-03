import { useMemo } from 'react';

import type { AgentDelegationSession } from '@caxri/protocol';

import { useTerminal } from '../../../../stores/selectors';
import { useDelegationFeed } from '../../../delegation/hooks/use-delegation-feed';
import { sortDelegatedSessions } from '../agent-chat-delegated-sessions';
import { useCanShowDelegatedSessions } from './use-can-show-delegated-sessions';

/**
 * The Sessions this Chat's Agent delegated to, consulted, or handed off to, one entry per child Session in the order a
 * person should look at them. Reads `agent.delegation.sessions` for this Chat's own Session through the same cache
 * entries and invalidation as the sidebar's nested rows. Asks nothing where the window cannot show them.
 */
export function useDelegatedSessions(terminalId: string): readonly AgentDelegationSession[] {
    const canShow = useCanShowDelegatedSessions();
    const sessionId = useTerminal(terminalId)?.sessionId;
    const chunks = useMemo(() => (sessionId ? [[sessionId]] : []), [sessionId]);
    const { entries } = useDelegationFeed(chunks, { isEnabled: canShow });
    return useMemo(() => sortDelegatedSessions(entries), [entries]);
}
