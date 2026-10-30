import type { AgentUsageReadout, UsageLimit } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentUsageClockSignature,
    agentUsageLabel,
    agentUsageLimitTone,
    agentUsagePaceNote,
    agentUsageResetCreditsNote,
    agentUsageResetCreditsValue,
    agentUsageWarningReason,
} from '../agent-usage-label';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const ALL_WINDOWS = { limitWindows: 'both' } as const;
const DEFAULT_WINDOWS = { limitWindows: 'auto' } as const;

function readout(overrides: Partial<AgentUsageReadout> = {}): AgentUsageReadout {
    return {
        provider: 'codex',
        tokens: {
            input: 200_000,
            output: 50_000,
            cacheRead: 950_000,
            cacheWrite: 0,
            reasoning: 0,
            total: 1_200_000,
        },
        costUsd: 3.4,
        models: ['gpt-5.5'],
        unpricedModels: [],
        ...overrides,
    };
}

describe('agent usage chip label', () => {
    it('shows tokens, cost, and every live rate-limit window shortest first', () => {
        const label = agentUsageLabel(
            readout({
                limit: {
                    provider: 'codex',
                    observedAt: NOW,
                    windows: [
                        { windowMinutes: 10_080, usedPercent: 12, resetsAt: NOW + 86_400_000 },
                        { windowMinutes: 300, usedPercent: 61.6, resetsAt: NOW + 3_600_000 },
                    ],
                },
            }),
            NOW,
            ALL_WINDOWS,
            translate,
        );
        // 61.6% used leaves 38% of the 5-hour window; 12% used leaves 88% of the week.
        expect(label).toBe('1.2M · $3.40 · 5h 38% left · wk 88% left');
    });

    it('drops a window that already reset and leaves out cost when no model is priced', () => {
        const label = agentUsageLabel(
            readout({
                unpricedModels: ['gpt-5.5'],
                limit: {
                    provider: 'codex',
                    observedAt: NOW - 7_200_000,
                    windows: [{ windowMinutes: 300, usedPercent: 90, resetsAt: NOW - 1 }],
                },
            }),
            NOW,
            ALL_WINDOWS,
            translate,
        );
        expect(label).toBe('1.2M');
    });

    it('marks a cost that leaves some unpriced models out as a lower bound', () => {
        const partial = readout({ models: ['gpt-5.5', 'mystery'], unpricedModels: ['mystery'] });
        expect(agentUsageLabel(partial, NOW, DEFAULT_WINDOWS, translate)).toBe('1.2M · ≥$3.40');
    });

    describe('limit windows Setting', () => {
        function claude(plan: Partial<Pick<UsageLimit, 'planType' | 'rateLimitTier'>>) {
            return readout({
                limit: {
                    provider: 'claude',
                    observedAt: NOW,
                    ...plan,
                    windows: [
                        { windowMinutes: 10_080, usedPercent: 20, resetsAt: NOW + 86_400_000 },
                        { windowMinutes: 300, usedPercent: 21, resetsAt: NOW + 3_600_000 },
                    ],
                },
            });
        }
        const FIVE_HOUR = '1.2M · $3.40 · 5h 79% left';
        const WEEKLY = '1.2M · $3.40 · wk 80% left';

        it('shows the 5-hour window for Claude Pro and Max 5x by default', () => {
            expect(
                agentUsageLabel(claude({ planType: 'pro' }), NOW, DEFAULT_WINDOWS, translate),
            ).toBe(FIVE_HOUR);
            const max5x = claude({ planType: 'max', rateLimitTier: 'default_claude_max_5x' });
            expect(agentUsageLabel(max5x, NOW, DEFAULT_WINDOWS, translate)).toBe(FIVE_HOUR);
        });

        it('shows the weekly window for every other plan by default', () => {
            const max20x = claude({ planType: 'max', rateLimitTier: 'default_claude_max_20x' });
            expect(agentUsageLabel(max20x, NOW, DEFAULT_WINDOWS, translate)).toBe(WEEKLY);
            expect(
                agentUsageLabel(claude({ planType: 'max' }), NOW, DEFAULT_WINDOWS, translate),
            ).toBe(WEEKLY);
            expect(agentUsageLabel(claude({}), NOW, DEFAULT_WINDOWS, translate)).toBe(WEEKLY);
            const codexPro = claude({ planType: 'pro' });
            codexPro.limit = { ...codexPro.limit!, provider: 'codex' };
            expect(agentUsageLabel(codexPro, NOW, DEFAULT_WINDOWS, translate)).toBe(WEEKLY);
        });

        it('falls back to the other window when the plan pick has none live', () => {
            const pro = claude({ planType: 'pro' });
            pro.limit = { ...pro.limit!, windows: pro.limit!.windows.slice(0, 1) };
            expect(agentUsageLabel(pro, NOW, DEFAULT_WINDOWS, translate)).toBe(WEEKLY);
        });

        it('follows an explicit choice regardless of plan', () => {
            const pro = claude({ planType: 'pro' });
            expect(agentUsageLabel(pro, NOW, { limitWindows: 'weekly' }, translate)).toBe(WEEKLY);
            const max20x = claude({ planType: 'max', rateLimitTier: 'default_claude_max_20x' });
            expect(agentUsageLabel(max20x, NOW, { limitWindows: 'fiveHour' }, translate)).toBe(
                FIVE_HOUR,
            );
            expect(agentUsageLabel(pro, NOW, ALL_WINDOWS, translate)).toBe(
                '1.2M · $3.40 · 5h 79% left · wk 80% left',
            );
        });
    });
});

describe('agent usage limit tone', () => {
    function withWindows(fiveHour: number, weekly: number, weeklyResetsAt = NOW + 86_400_000) {
        return readout({
            limit: {
                provider: 'codex',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: weekly, resetsAt: weeklyResetsAt },
                    { windowMinutes: 300, usedPercent: fiveHour, resetsAt: NOW + 3_600_000 },
                ],
            },
        });
    }

    it('warns while any displayed window crosses the Usage page warning threshold', () => {
        expect(agentUsageLimitTone(withWindows(89.4, 40), NOW, ALL_WINDOWS)).toBeUndefined();
        expect(agentUsageLimitTone(withWindows(89.6, 40), NOW, ALL_WINDOWS)).toBe('warning');
        expect(agentUsageLimitTone(withWindows(10, 95), NOW, ALL_WINDOWS)).toBe('warning');
        expect(agentUsageLimitTone(withWindows(10, 99, NOW - 1), NOW, ALL_WINDOWS)).toBeUndefined();
    });

    it('ignores the pace of a window the chip does not show', () => {
        const DAY = 86_400_000;
        const behind = withWindows(10, 30, NOW + 6 * DAY);
        expect(agentUsageLimitTone(behind, NOW, DEFAULT_WINDOWS)).toBe('warning');
        expect(agentUsageLimitTone(behind, NOW, { limitWindows: 'fiveHour' })).toBeUndefined();
    });

    it('warns while the weekly window is projected to run out before it resets', () => {
        const DAY = 86_400_000;
        // 30% used in 1 of 7 days projects 210%.
        expect(agentUsageLimitTone(withWindows(10, 30, NOW + 6 * DAY), NOW, DEFAULT_WINDOWS)).toBe(
            'warning',
        );
        // 14% used after 12 hours is too early to project.
        expect(
            agentUsageLimitTone(withWindows(10, 14, NOW + 6.5 * DAY), NOW, DEFAULT_WINDOWS),
        ).toBeUndefined();
        // 10% used with 6 of 7 days left projects 70%.
        expect(
            agentUsageLimitTone(withWindows(10, 10, NOW + 6 * DAY), NOW, DEFAULT_WINDOWS),
        ).toBeUndefined();
    });

    it('drops the pace warning once dismissed today but still warns on a nearly spent window', () => {
        const DAY = 86_400_000;
        expect(
            agentUsageLimitTone(withWindows(10, 30, NOW + 6 * DAY), NOW, DEFAULT_WINDOWS, true),
        ).toBeUndefined();
        expect(agentUsageLimitTone(withWindows(10, 95), NOW, DEFAULT_WINDOWS, true)).toBe(
            'warning',
        );
    });

    it('explains a pace warning in plain words and stays silent otherwise', () => {
        const DAY = 86_400_000;
        expect(agentUsagePaceNote(withWindows(10, 30, NOW + 6 * DAY), NOW, translate)).toBe(
            'Weekly limit: 70% left, resets in 6d 0h. At this rate it runs out before it resets; the warning clears as usage slows or time passes.',
        );
        expect(
            agentUsagePaceNote(withWindows(10, 10, NOW + 6 * DAY), NOW, translate),
        ).toBeUndefined();
    });

    it('follows only the windows the chip shows', () => {
        expect(agentUsageLimitTone(withWindows(95, 40), NOW, { limitWindows: 'weekly' })).toBe(
            undefined,
        );
        expect(agentUsageLimitTone(withWindows(10, 95), NOW, { limitWindows: 'fiveHour' })).toBe(
            undefined,
        );
        expect(agentUsageLimitTone(withWindows(10, 95), NOW, DEFAULT_WINDOWS)).toBe('warning');
    });

    describe('auto mode on a five-hour-bound plan', () => {
        const proUsage = (fiveHour: number, weekly: number) =>
            readout({
                provider: 'claude',
                limit: {
                    provider: 'claude',
                    planType: 'pro',
                    observedAt: NOW,
                    windows: [
                        { windowMinutes: 10_080, usedPercent: weekly, resetsAt: NOW + 86_400_000 },
                        { windowMinutes: 300, usedPercent: fiveHour, resetsAt: NOW + 3_600_000 },
                    ],
                },
            });

        it('promotes a nearly spent weekly window into the chip text so colour and text agree', () => {
            const usage = proUsage(10, 97);
            expect(agentUsageLabel(usage, NOW, DEFAULT_WINDOWS, translate)).toBe(
                '1.2M · $3.40 · 5h 90% left · wk 3% left',
            );
            expect(agentUsageLimitTone(usage, NOW, DEFAULT_WINDOWS)).toBe('warning');
            // 97% used one day into the week also projects past the limit, so both causes are named.
            expect(agentUsageWarningReason(usage, NOW, DEFAULT_WINDOWS, translate)).toBe(
                'a rate limit is nearly used up; a rate limit will run out before it resets',
            );
            expect(agentUsageWarningReason(usage, NOW, DEFAULT_WINDOWS, translate, true)).toBe(
                'a rate limit is nearly used up',
            );
        });

        it('keeps showing only the five-hour window while the week has room', () => {
            const usage = proUsage(10, 50);
            expect(agentUsageLabel(usage, NOW, DEFAULT_WINDOWS, translate)).toBe(
                '1.2M · $3.40 · 5h 90% left',
            );
            expect(agentUsageLimitTone(usage, NOW, DEFAULT_WINDOWS)).toBeUndefined();
            expect(agentUsageWarningReason(usage, NOW, DEFAULT_WINDOWS, translate)).toBeUndefined();
        });
    });

    it('has no tone without a live window', () => {
        expect(agentUsageLimitTone(readout(), NOW, ALL_WINDOWS)).toBeUndefined();
        const reset = readout({
            limit: {
                provider: 'codex',
                observedAt: NOW,
                windows: [{ windowMinutes: 300, usedPercent: 99, resetsAt: NOW - 1 }],
            },
        });
        expect(agentUsageLimitTone(reset, NOW, ALL_WINDOWS)).toBeUndefined();
    });
});

describe('agent usage clock signature', () => {
    const limit = {
        provider: 'codex' as const,
        observedAt: NOW,
        windows: [{ windowMinutes: 300, usedPercent: 40, resetsAt: NOW + 3_600_000 }],
    };

    it('stays the same across instants that render the same reset wording', () => {
        expect(agentUsageClockSignature(limit, NOW, translate)).toBe(
            agentUsageClockSignature(limit, NOW + 2_000, translate),
        );
        expect(agentUsageClockSignature(undefined, NOW, translate)).toBe('');
    });

    it('changes when the reset wording turns over or the window resets', () => {
        expect(agentUsageClockSignature(limit, NOW + 120_000, translate)).not.toBe(
            agentUsageClockSignature(limit, NOW, translate),
        );
        expect(agentUsageClockSignature(limit, NOW + 3_600_000, translate)).toBe('');
    });
});

describe('banked reset credits', () => {
    const limit = (resetCredits: { availableCount: number; nextExpiresAt?: number }) => ({
        provider: 'codex' as const,
        observedAt: NOW,
        windows: [{ windowMinutes: 10_080, usedPercent: 10, resetsAt: NOW + 86_400_000 }],
        resetCredits,
    });
    const DAY = 86_400_000;

    it('states the count and the soonest expiry, or the count alone without one', () => {
        expect(
            agentUsageResetCreditsValue(
                limit({ availableCount: 2, nextExpiresAt: NOW + 3 * DAY + 4 * 3_600_000 }),
                NOW,
                translate,
            ),
        ).toBe('2 · next expires in 3d 4h');
        expect(agentUsageResetCreditsValue(limit({ availableCount: 1 }), NOW, translate)).toBe('1');
        expect(agentUsageResetCreditsValue(undefined, NOW, translate)).toBeUndefined();
        expect(
            agentUsageResetCreditsValue(limit({ availableCount: 0 }), NOW, translate),
        ).toBeUndefined();
        // An expiry that has passed means the count is stale until the next reading.
        expect(
            agentUsageResetCreditsValue(
                limit({ availableCount: 2, nextExpiresAt: NOW - 1 }),
                NOW,
                translate,
            ),
        ).toBeUndefined();
    });

    it('warns on the chip only within a day of the soonest expiry', () => {
        const tone = (nextExpiresAt: number) =>
            agentUsageLimitTone(
                readout({ limit: limit({ availableCount: 1, nextExpiresAt }) }),
                NOW,
                DEFAULT_WINDOWS,
            );
        expect(tone(NOW + 12 * 3_600_000)).toBe('warning');
        expect(tone(NOW + 3 * DAY)).toBeUndefined();
        expect(
            agentUsageResetCreditsNote(
                limit({ availableCount: 1, nextExpiresAt: NOW + 12 * 3_600_000 }),
                NOW,
                translate,
            ),
        ).toContain('expires in 12h');
        expect(
            agentUsageResetCreditsNote(
                limit({ availableCount: 1, nextExpiresAt: NOW + 3 * DAY }),
                NOW,
                translate,
            ),
        ).toBeUndefined();
    });

    it('changes the clock signature as the expiry wording moves', () => {
        const credits = limit({ availableCount: 1, nextExpiresAt: NOW + 3 * DAY });
        expect(agentUsageClockSignature(credits, NOW, translate)).not.toBe(
            agentUsageClockSignature(credits, NOW + DAY, translate),
        );
    });
});
