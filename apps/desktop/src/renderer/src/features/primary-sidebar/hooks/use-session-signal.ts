import type { SessionSignal } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';

/**
 * One Session's live signals (a hot process tree, an open Keychain dialog). Every row shares one cached read that
 * `terminal.sessionSignalsChanged` overwrites in `queries/invalidation.ts`, and `select` narrows each row to its own
 * entry, so a change re-renders only the rows it touched. `refetchOnMount: false` keeps expanding a Project group from
 * issuing one read per row.
 */
export function useSessionSignal(sessionId: string): SessionSignal | undefined {
    return useCaxriQuery(
        'terminal.sessionSignals',
        {},
        {
            refetchOnMount: false,
            select: (signals) => signals.sessions[sessionId],
            staleTime: Infinity,
        },
    ).data;
}
