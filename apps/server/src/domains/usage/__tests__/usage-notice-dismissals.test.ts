import type { UsageLimit } from '@caxri/protocol';
import { isPlanPaceDismissed } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { UsageNoticeDismissals } from '../usage-notice-dismissals';

const NOW = new Date(2026, 9, 27, 23, 0).getTime();

const limit = (provider: UsageLimit['provider']): UsageLimit => ({
    provider,
    observedAt: NOW,
    windows: [{ windowMinutes: 10_080, usedPercent: 58.4, resetsAt: NOW + 4 * 86_400_000 }],
});

function harness(state: Record<string, unknown> = {}) {
    const database = {
        getAppState: (key: string) => state[key],
        setAppState: (key: string, value: unknown) => {
            state[key] = value;
        },
    } as unknown as Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;
    const write = vi.fn<StructuredLogger['write']>();
    const logger = { write } as unknown as StructuredLogger;
    return {
        state,
        write,
        open: () =>
            new UsageNoticeDismissals({
                database,
                logger,
                now: () => NOW,
                limits: () => [limit('claude')],
            }),
    };
}

describe('UsageNoticeDismissals', () => {
    it('keeps a dismissal per provider across a Server restart and attaches it to readings', () => {
        const { state, open } = harness();
        open().dismiss('planPace', 'claude');

        const restarted = open();
        const claude = restarted.attach(limit('claude'));
        expect(claude.paceDismissedAt).toBe(NOW);
        expect(isPlanPaceDismissed(claude, NOW + 30 * 60_000)).toBe(true);
        expect(restarted.attach(limit('codex'))).not.toHaveProperty('paceDismissedAt');
        expect(state.planPaceDismissals).toEqual({ claude: NOW });
    });

    it('keeps the credits notice dismissal apart from the pace reminder', () => {
        const { state, open } = harness();
        open().dismiss('credits', 'codex');

        const codex = open().attach(limit('codex'));
        expect(codex.creditsNoticeDismissedAt).toBe(NOW);
        expect(codex).not.toHaveProperty('paceDismissedAt');
        expect(state).toEqual({ creditsNoticeDismissals: { codex: NOW } });
    });

    it('logs the provider and how much of the week was used, without any other content', () => {
        const { open, write } = harness();
        open().dismiss('planPace', 'claude');
        open().dismiss('credits', 'codex');
        expect(write.mock.calls.map((call) => call[2]?.fields)).toEqual([
            { provider: 'claude', usedPercent: 58 },
            { provider: 'codex', usedPercent: null },
        ]);
        expect(write.mock.calls.map((call) => call[1])).toEqual([
            'usage.plan_pace_dismissed',
            'usage.credits_notice_dismissed',
        ]);
    });
});
