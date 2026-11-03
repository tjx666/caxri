import { useMemo } from 'react';

import { keepPreviousData } from '@tanstack/react-query';

import { useCaxriQuery } from '../../../../queries/client';
import { useSessionById, useTerminal } from '../../../../stores/selectors';
import { agentChatReadFollowOptions } from '../../agent-chat-cache-retention';
import type { DelegationOrigin } from '../agent-chat-delegation-origin';
import { delegationOrigin } from '../agent-chat-delegation-origin';
import { useCanShowDelegatedSessions } from './use-can-show-delegated-sessions';
import { useIsDelegationLive } from './use-is-delegation-live';

/**
 * Same window as the feed's other readers (`useDelegationFeed`); the push invalidation keeps it current.
 */
const TAKEOVER_STALE_TIME_MS = 60_000;

export interface DelegationOriginState {
    origin: DelegationOrigin | undefined;
    /**
     * When the user first acted in this Session, taking it over; `undefined` until then.
     */
    takenOverAt: number | undefined;
}

const NONE: DelegationOriginState = { origin: undefined, takenOverAt: undefined };

/**
 * Where this Chat's Session came from, for the composer's origin row and the timeline's takeover divider. The origin
 * comes from the Session records the Renderer already holds, so the row paints with the strip and does not wait for a
 * read; only the takeover time comes from the feed (`agent.delegation.sessions` of the parent), narrowed by `select` to
 * this Session's `takenOverAt`, so a progress patch on a sibling never re-renders a Chat that only reads this.
 *
 * Asks nothing and reports no origin where the window cannot show delegated Sessions. A hidden kept-alive Chat follows
 * no change of the takeover time (`DelegationLiveContext`) and reads the latest when it is shown again.
 */
export function useDelegationOrigin(terminalId: string): DelegationOriginState {
    const canShow = useCanShowDelegatedSessions();
    const isLive = useIsDelegationLive();
    const sessionId = useTerminal(terminalId)?.sessionId;
    const session = useSessionById(sessionId);
    const parent = useSessionById(session?.createdBySessionId);
    const isDelegatedChild =
        canShow &&
        parent !== undefined &&
        (session?.createdByRelation === 'delegated' || session?.createdByRelation === 'consult');
    const { data: takenOverAt } = useCaxriQuery(
        'agent.delegation.sessions',
        { createdBySessionIds: [parent?.id ?? ''] },
        {
            enabled: isDelegatedChild,
            // A kept-alive Chat in the background stays subscribed but is told about no change.
            ...agentChatReadFollowOptions(isLive),
            placeholderData: keepPreviousData,
            select: (feed) =>
                feed.sessions.find((entry) => entry.sessionId === sessionId)?.takenOverAt,
            staleTime: TAKEOVER_STALE_TIME_MS,
        },
    );
    return useMemo(() => {
        if (!canShow || !session) return NONE;
        const origin = delegationOrigin(session, parent, takenOverAt);
        return origin ? { origin, takenOverAt } : NONE;
    }, [canShow, session, parent, takenOverAt]);
}
