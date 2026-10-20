import { CaxriError } from '@caxri/protocol';

export const MAX_TERMINALS_PER_SESSION = 16;
export const MAX_TERMINALS_GLOBAL = 32;

/**
 * The live-Terminal counts the limits are checked against; see `TerminalsModel.countAll`.
 */
interface TerminalCounts {
    countAll(): number;
    countForSession(sessionId: string): number;
}

/**
 * Enforces the shared Terminal limits before either single-Terminal or bulk creation mutates the database.
 */
export function assertTerminalCapacity(terminals: TerminalCounts, sessionId?: string): void {
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
