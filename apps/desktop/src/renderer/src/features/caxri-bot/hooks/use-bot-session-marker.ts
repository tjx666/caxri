import { useCaxriQuery } from '../../../queries/client';
import type { BotSessionMarker } from '../bot-managed-sessions';
import { botSessionMarker } from '../bot-managed-sessions';
import { useBotManagedSessions } from './use-bot-managed-sessions';

/**
 * One Session row's Caxri Bot marker. Every row shares one cached read that the ownership feed refreshes on a full
 * state change, and `select` narrows each row's subscription to its own answer, so a hand-over re-renders only the rows
 * it changed. `refetchOnMount: false` keeps expanding a Project group from issuing one read per row. The run state is
 * the status bar chip's cached read, which `state.changed` invalidates, so stopping Caxri Bot clears every marker.
 */
export function useBotSessionMarker(sessionId: string): BotSessionMarker {
    useBotManagedSessions();
    const runState = useCaxriQuery(
        'bot.status',
        {},
        { refetchOnMount: false, select: (status) => status.state },
    ).data;
    return (
        useCaxriQuery(
            'bot.managedSessions',
            {},
            {
                refetchOnMount: false,
                select: (managed) => botSessionMarker(managed, sessionId, runState),
                staleTime: Infinity,
            },
        ).data ?? 'none'
    );
}
