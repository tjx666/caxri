import type { UsageLimit } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { AgentUsageGuards } from '../usage-guard';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const HOUR = 3_600_000;
const RESET = T0 + 48 * HOUR;

function reading(usedPercent: number, resetsAt = RESET): Pick<UsageLimit, 'windows'> {
    return {
        windows: [
            { windowMinutes: 300, usedPercent: 12, resetsAt: T0 + HOUR, scope: 'session' },
            { windowMinutes: 10_080, usedPercent, resetsAt, scope: 'weekly' },
        ],
    };
}

function harness(stored: Record<string, unknown> = {}) {
    const state = stored;
    const database = {
        getAppState: (key: string) => state[key],
        setAppState: (key: string, value: unknown) => {
            state[key] = value;
        },
    } as unknown as Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;
    const write = vi.fn<StructuredLogger['write']>();
    let now = T0;
    const guards = new AgentUsageGuards({
        database,
        logger: { write } as unknown as StructuredLogger,
        now: () => now,
    });
    return {
        guards,
        state,
        write,
        outcomes: () => write.mock.calls.map((call) => call[2]?.fields?.outcome),
        advance: (ms: number) => {
            now += ms;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('AgentUsageGuards', () => {
    it('arms at 99% of the weekly window and refuses requests with the reset time', () => {
        const { guards, outcomes } = harness();
        guards.observe('claude', reading(98.9));
        expect(guards.current('claude')).toBeUndefined();
        guards.observe('claude', reading(99));
        expect(guards.current('claude')).toEqual({
            provider: 'claude',
            usedPercent: 99,
            resetsAt: RESET,
            handoff: 'available',
        });
        expect(() => guards.assertAdmitted('claude', 'chat_send')).toThrow(
            expect.objectContaining({
                code: 'USAGE_LIMITED',
                details: { provider: 'claude', resetsAt: RESET },
            }),
        );
        expect(() => guards.assertAdmitted('codex', 'chat_send')).not.toThrow();
        expect(outcomes()).toEqual(['armed', 'refused']);
        guards.close();
    });

    it('stays armed on a lower reading of the same window and lifts for a later window', () => {
        const { guards, outcomes } = harness();
        guards.observe('codex', reading(99.4));
        // A rounded or older reading of the same week does not give the reserved budget back.
        guards.observe('codex', reading(97, RESET + 5 * 60_000));
        expect(guards.current('codex')).toBeDefined();
        guards.observe('codex', reading(3, RESET + 7 * 24 * HOUR));
        expect(guards.current('codex')).toBeUndefined();
        expect(outcomes()).toEqual(['armed', 'window_reset']);
        guards.close();
    });

    it('ignores a window that already reset and a reading without a weekly window', () => {
        const { guards } = harness();
        guards.observe('claude', reading(100, T0 - 1));
        guards.observe('claude', { windows: [{ windowMinutes: 300, usedPercent: 100 }] });
        expect(guards.current('claude')).toBeUndefined();
        guards.close();
    });

    it('lifts itself at resetsAt and tells subscribers', () => {
        vi.useFakeTimers({ now: T0 });
        const { guards, advance, outcomes } = harness();
        const listener = vi.fn();
        guards.subscribe(listener);
        guards.observe('claude', reading(99.5, T0 + HOUR));
        expect(listener).toHaveBeenCalledWith('claude');
        advance(HOUR);
        vi.advanceTimersByTime(HOUR);
        expect(guards.current('claude')).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(outcomes()).toEqual(['armed', 'window_reset']);
        guards.close();
    });

    it('grants one hand-off per account and window, kept across a restart', () => {
        const first = harness();
        expect(() => first.guards.claimHandoff('claude', 'terminal-1')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        first.guards.observe('claude', reading(99.2));
        first.guards.claimHandoff('claude', 'terminal-1');
        expect(first.guards.current('claude')?.handoff).toBe('generating');
        expect(() => first.guards.claimHandoff('claude', 'terminal-2')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        first.guards.settleHandoff('claude', 'terminal-1', {
            status: 'generated',
            text: 'Next: finish the parser.',
            createdAt: T0,
        });
        first.guards.close();

        const restarted = harness(first.state);
        expect(restarted.guards.current('claude')?.handoff).toBe('used');
        expect(restarted.guards.document('claude', 'terminal-1')).toMatchObject({
            status: 'generated',
            text: 'Next: finish the parser.',
        });
        expect(restarted.guards.document('claude', 'terminal-2')).toBeUndefined();
        expect(() => restarted.guards.claimHandoff('claude', 'terminal-1')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        restarted.guards.close();
    });

    it('drops a stored record it cannot read instead of failing to start', () => {
        const { guards } = harness({ agentUsageGuards: 'corrupt' });
        expect(guards.current('claude')).toBeUndefined();
        guards.close();
    });
});
