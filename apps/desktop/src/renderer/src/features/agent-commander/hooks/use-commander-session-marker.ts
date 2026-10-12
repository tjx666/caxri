import { useCaxriQuery } from '../../../queries/client';
import type { CommanderSessionMarker } from '../commander-managed-sessions';
import { commanderSessionMarker } from '../commander-managed-sessions';
import { useCommanderManagedSessions } from './use-commander-managed-sessions';

/**
 * One Session row's Commander marker. Every row shares one cached read that the ownership feed refreshes on a full
 * state change, and `select` narrows each row's subscription to its own answer, so a hand-over re-renders only the rows
 * it changed. `refetchOnMount: false` keeps expanding a Project group from issuing one read per row.
 */
export function useCommanderSessionMarker(sessionId: string): CommanderSessionMarker {
    useCommanderManagedSessions();
    return (
        useCaxriQuery(
            'commander.managedSessions',
            {},
            {
                refetchOnMount: false,
                select: (managed) => commanderSessionMarker(managed, sessionId),
                staleTime: Infinity,
            },
        ).data ?? 'none'
    );
}
