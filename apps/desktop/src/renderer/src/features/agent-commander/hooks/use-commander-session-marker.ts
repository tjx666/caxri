import { useCaxriQuery } from '../../../queries/client';
import type { CommanderSessionMarker } from '../commander-managed-sessions';
import { commanderSessionMarker } from '../commander-managed-sessions';
import { useCommanderManagedSessions } from './use-commander-managed-sessions';

/**
 * One Session row's Commander marker. Every row shares one cached read that the ownership feed refreshes on a full
 * state change, and `select` narrows each row's subscription to its own answer, so a hand-over re-renders only the rows
 * it changed. `refetchOnMount: false` keeps expanding a Project group from issuing one read per row. The run state is
 * the status bar chip's cached read, which `state.changed` invalidates, so stopping the Commander clears every marker.
 */
export function useCommanderSessionMarker(sessionId: string): CommanderSessionMarker {
    useCommanderManagedSessions();
    const runState = useCaxriQuery(
        'commander.status',
        {},
        { refetchOnMount: false, select: (status) => status.state },
    ).data;
    return (
        useCaxriQuery(
            'commander.managedSessions',
            {},
            {
                refetchOnMount: false,
                select: (managed) => commanderSessionMarker(managed, sessionId, runState),
                staleTime: Infinity,
            },
        ).data ?? 'none'
    );
}
