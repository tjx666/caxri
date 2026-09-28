import { describe, expect, it } from 'vitest';

import { RETIRED_TERMINAL_FENCE_LIMIT, TerminalGenerationLedger } from '../generation-ledger';

describe('architecture-a3b-terminal-host: TerminalGenerationLedger', () => {
    it('requires exactly the next generation once a launch started', () => {
        const ledger = new TerminalGenerationLedger();
        expect(ledger.launchGeneration('terminal-1')).toBeUndefined();
        ledger.recordStart('terminal-1', 3);
        expect(ledger.launchGeneration('terminal-1')).toBe(4);
        expect(ledger.isRetired('terminal-1')).toBe(false);
    });

    it('releases a retired baseline and ignores a start that completes after retirement', () => {
        const ledger = new TerminalGenerationLedger();
        ledger.recordStart('terminal-1', 2);
        ledger.retire('terminal-1');
        ledger.recordStart('terminal-1', 3);
        expect(ledger.launchGeneration('terminal-1')).toBeUndefined();
        expect(ledger.isRetired('terminal-1')).toBe(true);
    });

    it('bounds the retirement fence by evicting the oldest closure first', () => {
        const ledger = new TerminalGenerationLedger();
        const overflow = 10;
        for (let index = 0; index < RETIRED_TERMINAL_FENCE_LIMIT + overflow; index += 1) {
            ledger.recordStart(`terminal-${index}`, 1);
            ledger.retire(`terminal-${index}`);
        }
        const internals = ledger as unknown as {
            retired: Set<string>;
            started: Map<string, number>;
        };
        expect(internals.started.size).toBe(0);
        expect(internals.retired.size).toBe(RETIRED_TERMINAL_FENCE_LIMIT);
        expect(ledger.isRetired('terminal-0')).toBe(false);
        expect(ledger.isRetired(`terminal-${overflow - 1}`)).toBe(false);
        expect(ledger.isRetired(`terminal-${overflow}`)).toBe(true);
        expect(ledger.isRetired(`terminal-${RETIRED_TERMINAL_FENCE_LIMIT + overflow - 1}`)).toBe(
            true,
        );
    });

    it('refreshes a repeated retirement so the latest closure stays fenced longest', () => {
        const ledger = new TerminalGenerationLedger();
        ledger.retire('terminal-first');
        for (let index = 1; index < RETIRED_TERMINAL_FENCE_LIMIT; index += 1)
            ledger.retire(`terminal-${index}`);
        ledger.retire('terminal-first');
        ledger.retire('terminal-overflow');
        expect(ledger.isRetired('terminal-first')).toBe(true);
        expect(ledger.isRetired('terminal-1')).toBe(false);
    });
});
