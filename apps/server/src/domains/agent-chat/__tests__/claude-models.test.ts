import { describe, expect, it } from 'vitest';

import { claudeFastMode, ClaudeFastModeGate } from '../claude-models';

describe('claudeFastMode', () => {
    const fast = (message: Record<string, unknown>) => {
        const operation = claudeFastMode(message).at(0);
        return operation?.op === 'state' ? operation.state.fast : undefined;
    };

    it('reports Fast mode on, including the cooldown after a rate limit', () => {
        expect(fast({ fast_mode_state: 'on' })).toBe(true);
        expect(fast({ fast_mode_state: 'cooldown' })).toBe(true);
    });

    it('keeps the toggle off but offered while only the Agent SDK opt-in or an org check stands in the way', () => {
        expect(fast({ fast_mode_state: 'off' })).toBe(false);
        expect(
            fast({ fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' }),
        ).toBe(false);
        expect(fast({ fast_mode_state: 'off', fast_mode_disabled_reason: 'pending' })).toBe(false);
    });

    it('withdraws the toggle when the plan, a policy, or the API provider blocks Fast mode', () => {
        for (const reason of ['free', 'preference', 'not_first_party', 'model_not_allowed'])
            expect(fast({ fast_mode_state: 'off', fast_mode_disabled_reason: reason })).toBeNull();
    });

    it('reports nothing for a CLI that predates the field', () => {
        expect(claudeFastMode({ subtype: 'init' })).toEqual([]);
    });
});

describe('ClaudeFastModeGate', () => {
    const offered = { fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' };
    const fast = (operations: ReturnType<ClaudeFastModeGate['report']>) => {
        const operation = operations.at(0);
        return operation?.op === 'state' ? operation.state.fast : undefined;
    };
    const report = (gate: ClaudeFastModeGate, message: Record<string, unknown>) =>
        fast(gate.report(claudeFastMode(message)));

    it('withdraws the offered toggle while extra usage is off and offers it again once it is on', () => {
        const gate = new ClaudeFastModeGate();
        expect(report(gate, offered)).toBe(false);
        expect(fast(gate.setExtraUsage(false))).toBeNull();
        expect(report(gate, offered)).toBeNull();
        expect(gate.setExtraUsage(false)).toEqual([]);
        expect(fast(gate.setExtraUsage(true))).toBe(false);
    });

    it('keeps a Fast mode that is on, and changes nothing before Claude Code reports one', () => {
        const gate = new ClaudeFastModeGate();
        expect(gate.setExtraUsage(false)).toEqual([]);
        expect(report(gate, { fast_mode_state: 'on' })).toBe(true);
        expect(report(gate, offered)).toBeNull();
    });

    it('passes operations without a Fast mode through unchanged', () => {
        const operations = [{ op: 'state' as const, state: { model: 'opus' } }];
        expect(new ClaudeFastModeGate().report(operations)).toEqual(operations);
    });
});
