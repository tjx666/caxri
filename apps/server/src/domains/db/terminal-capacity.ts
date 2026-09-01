import { CaxriError } from '@caxri/protocol';

import type { TerminalsModel } from './models/terminals';
import { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from './models/terminals';

/**
 * Enforces the shared Terminal limits before either single-Terminal or bulk creation mutates the database.
 */
export function assertTerminalCapacity(
    terminals: Pick<TerminalsModel, 'countAll' | 'countForSession'>,
    sessionId?: string,
): void {
    if (terminals.countAll() >= MAX_TERMINALS_GLOBAL)
        throw new CaxriError(
            'CAPACITY',
            `Caxri supports at most ${MAX_TERMINALS_GLOBAL} Terminals`,
        );
    if (sessionId && terminals.countForSession(sessionId) >= MAX_TERMINALS_PER_SESSION)
        throw new CaxriError(
            'CAPACITY',
            `A Session supports at most ${MAX_TERMINALS_PER_SESSION} Terminals`,
        );
}
