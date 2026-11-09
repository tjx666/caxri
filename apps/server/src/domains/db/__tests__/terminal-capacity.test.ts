import { terminalCapacityDetails } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    assertTerminalCapacity,
    MAX_TERMINALS_PER_SESSION,
    terminalGlobalLimit,
} from '../terminal-capacity';

const GIB = 1024 ** 3;

function caught(run: () => void): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('terminalGlobalLimit', () => {
    it('allows one live Terminal per GiB of memory between 32 and 128', () => {
        expect(terminalGlobalLimit(8 * GIB)).toBe(32);
        expect(terminalGlobalLimit(48 * GIB)).toBe(48);
        expect(terminalGlobalLimit(64.5 * GIB)).toBe(64);
        expect(terminalGlobalLimit(128 * GIB)).toBe(128);
        expect(terminalGlobalLimit(512 * GIB)).toBe(128);
    });
});

describe('assertTerminalCapacity', () => {
    const counts = (all: number, session: number) => ({
        countAll: () => all,
        countForSession: () => session,
    });

    it('names the global limit in the error details so a client can localize it', () => {
        const error = caught(() => assertTerminalCapacity(counts(64, 0), 'session-1', 64));

        expect(error).toMatchObject({ code: 'CAPACITY' });
        expect(terminalCapacityDetails(error)).toEqual({ terminalLimit: 'global', limit: 64 });
    });

    it('names the per-Session limit when only the Session is full', () => {
        const error = caught(() =>
            assertTerminalCapacity(counts(20, MAX_TERMINALS_PER_SESSION), 'session-1', 64),
        );

        expect(terminalCapacityDetails(error)).toEqual({
            terminalLimit: 'session',
            limit: MAX_TERMINALS_PER_SESSION,
        });
    });

    it('admits a Terminal below both limits', () => {
        expect(() => assertTerminalCapacity(counts(63, 15), 'session-1', 64)).not.toThrow();
    });
});
