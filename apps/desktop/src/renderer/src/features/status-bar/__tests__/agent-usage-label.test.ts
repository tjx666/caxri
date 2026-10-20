import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentUsageClockSignature,
    agentUsageCostLabel,
    agentUsageLabel,
    agentUsageLimitTone,
    agentUsagePaceNote,
} from '../agent-usage-label';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const ALL_WINDOWS = { showFiveHourLimit: true };
const DEFAULT_WINDOWS = { showFiveHourLimit: false };

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
        );
        // 61.6% used leaves 38% of the 5-hour window; 12% used leaves 88% of the week.
        expect(label).toBe('1.2M · $3.40 · 5h 38% · 7d 88% left');
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
        );
        expect(label).toBe('1.2M');
    });

    it('marks a cost that leaves some unpriced models out as a lower bound', () => {
        const partial = readout({ models: ['gpt-5.5', 'mystery'], unpricedModels: ['mystery'] });
        expect(agentUsageCostLabel(partial)).toBe('≥$3.40');
        expect(agentUsageLabel(partial, NOW, DEFAULT_WINDOWS)).toBe('1.2M · ≥$3.40');
        expect(agentUsageCostLabel(readout())).toBe('$3.40');
        expect(agentUsageCostLabel(readout({ unpricedModels: ['gpt-5.5'] }))).toBeUndefined();
    });

    it('leaves the 5-hour window out unless the Setting opts in', () => {
        const both = readout({
            limit: {
                provider: 'claude',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: 20, resetsAt: NOW + 86_400_000 },
                    { windowMinutes: 300, usedPercent: 21, resetsAt: NOW + 3_600_000 },
                ],
            },
        });
        expect(agentUsageLabel(both, NOW, DEFAULT_WINDOWS)).toBe('1.2M · $3.40 · 7d 80% left');
        expect(agentUsageLabel(both, NOW, ALL_WINDOWS)).toBe('1.2M · $3.40 · 5h 79% · 7d 80% left');
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

    it('warns while the weekly window runs ahead of an even pace', () => {
        const DAY = 86_400_000;
        // 30% used with 6 of 7 days left: an even pace leaves about 86%, this leaves 70%.
        expect(agentUsageLimitTone(withWindows(10, 30, NOW + 6 * DAY), NOW, DEFAULT_WINDOWS)).toBe(
            'warning',
        );
        // 10% used with 6 of 7 days left is on pace.
        expect(
            agentUsageLimitTone(withWindows(10, 10, NOW + 6 * DAY), NOW, DEFAULT_WINDOWS),
        ).toBeUndefined();
    });

    it('explains a pace warning in plain words and stays silent otherwise', () => {
        const DAY = 86_400_000;
        expect(agentUsagePaceNote(withWindows(10, 30, NOW + 6.5 * DAY), NOW)).toBe(
            'Weekly limit: 70% left, resets in 6d 12h. Using it faster than an even pace.',
        );
        expect(agentUsagePaceNote(withWindows(10, 10, NOW + 6 * DAY), NOW)).toBeUndefined();
    });

    it('follows only the windows the chip shows', () => {
        expect(agentUsageLimitTone(withWindows(95, 40), NOW, DEFAULT_WINDOWS)).toBeUndefined();
        expect(agentUsageLimitTone(withWindows(10, 95), NOW, DEFAULT_WINDOWS)).toBe('warning');
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
        expect(agentUsageClockSignature(limit, NOW)).toBe(
            agentUsageClockSignature(limit, NOW + 2_000),
        );
        expect(agentUsageClockSignature(undefined, NOW)).toBe('');
    });

    it('changes when the reset wording turns over or the window resets', () => {
        expect(agentUsageClockSignature(limit, NOW + 120_000)).not.toBe(
            agentUsageClockSignature(limit, NOW),
        );
        expect(agentUsageClockSignature(limit, NOW + 3_600_000)).toBe('');
    });
});
