import { totalmem } from 'node:os';

import type { TerminalCapacityDetails } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

export const MAX_TERMINALS_PER_SESSION = 16;

/**
 * The global floor and ceiling of {@link terminalGlobalLimit}. The floor keeps a small machine usable; the ceiling stays
 * far below macOS's default `kern.tty.ptmx_max` (511 PTYs shared with every other app).
 */
const MIN_TERMINALS_GLOBAL = 32;
const MAX_TERMINALS_GLOBAL = 128;
const BYTES_PER_GIB = 1024 ** 3;

/**
 * How many live Terminals (PTY and Agent Chat alike) the whole app may run: one per GiB of physical memory, clamped to
 * 32..128. A live Agent costs a provider process of a few hundred MB, so a fixed 32 refused new Sessions on a 128 GB
 * machine that had plenty of memory left, while a fixed 128 would let a 16 GB machine swap.
 */
export function terminalGlobalLimit(totalMemoryBytes: number = totalmem()): number {
    const perGib = Math.floor(totalMemoryBytes / BYTES_PER_GIB);
    return Math.min(MAX_TERMINALS_GLOBAL, Math.max(MIN_TERMINALS_GLOBAL, perGib));
}

/**
 * The live-Terminal counts the limits are checked against; see `TerminalsModel.countAll`.
 */
interface TerminalCounts {
    countAll(): number;
    countForSession(sessionId: string): number;
}

/**
 * Enforces the shared Terminal limits before either single-Terminal or bulk creation mutates the database. The error
 * carries {@link TerminalCapacityDetails} so a client can name the limit in its own locale.
 */
export function assertTerminalCapacity(
    terminals: TerminalCounts,
    sessionId?: string,
    globalLimit: number = terminalGlobalLimit(),
): void {
    if (terminals.countAll() >= globalLimit)
        throw new CaxriError(
            'CAPACITY',
            `Caxri supports at most ${globalLimit} running Terminals`,
            {
                terminalLimit: 'global',
                limit: globalLimit,
            } satisfies TerminalCapacityDetails,
        );
    if (sessionId && terminals.countForSession(sessionId) >= MAX_TERMINALS_PER_SESSION)
        throw new CaxriError(
            'CAPACITY',
            `A Session supports at most ${MAX_TERMINALS_PER_SESSION} running Terminals`,
            {
                terminalLimit: 'session',
                limit: MAX_TERMINALS_PER_SESSION,
            } satisfies TerminalCapacityDetails,
        );
}
