import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentUsageClockSignature,
    agentUsageCostLabel,
    agentUsageLabel,
    agentUsageLimitTone,
} from '../agent-usage-label';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

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
        );
        expect(label).toBe('1.2M');
    });

    it('marks a cost that leaves some unpriced models out as a lower bound', () => {
        const partial = readout({ models: ['gpt-5.5', 'mystery'], unpricedModels: ['mystery'] });
        expect(agentUsageCostLabel(partial)).toBe('≥$3.40');
        expect(agentUsageLabel(partial, NOW)).toBe('1.2M · ≥$3.40');
        expect(agentUsageCostLabel(readout())).toBe('$3.40');
        expect(agentUsageCostLabel(readout({ unpricedModels: ['gpt-5.5'] }))).toBeUndefined();
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
        expect(agentUsageLimitTone(withWindows(89.4, 40), NOW)).toBeUndefined();
        expect(agentUsageLimitTone(withWindows(89.6, 40), NOW)).toBe('warning');
        expect(agentUsageLimitTone(withWindows(10, 95), NOW)).toBe('warning');
        expect(agentUsageLimitTone(withWindows(10, 99, NOW - 1), NOW)).toBeUndefined();
    });

    it('has no tone without a live window', () => {
        expect(agentUsageLimitTone(readout(), NOW)).toBeUndefined();
        const reset = readout({
            limit: {
                provider: 'codex',
                observedAt: NOW,
                windows: [{ windowMinutes: 300, usedPercent: 99, resetsAt: NOW - 1 }],
            },
        });
        expect(agentUsageLimitTone(reset, NOW)).toBeUndefined();
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
