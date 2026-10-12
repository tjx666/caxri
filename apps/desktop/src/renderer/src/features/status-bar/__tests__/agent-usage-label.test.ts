import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentUsageCostLabel,
    agentUsageLabel,
    agentUsageLimitTone,
    currentLimitWindows,
    shortWindowName,
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
    it('shows tokens, cost, and the shortest live rate-limit window', () => {
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
        expect(label).toBe('1.2M · $3.40 · 5h 62%');
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

    it('keeps a window without a reset time and orders windows shortest first', () => {
        const windows = currentLimitWindows(
            {
                provider: 'codex',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: 1 },
                    { windowMinutes: 300, usedPercent: 2, resetsAt: NOW + 1 },
                ],
            },
            NOW,
        );
        expect(windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
    });

    it('names windows compactly', () => {
        expect(shortWindowName(300)).toBe('5h');
        expect(shortWindowName(10_080)).toBe('7d');
        expect(shortWindowName(90)).toBe('90m');
    });
});

describe('agent usage limit tone', () => {
    function withShortest(usedPercent: number, resetsAt = NOW + 3_600_000) {
        return readout({
            limit: {
                provider: 'codex',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: 99, resetsAt: NOW + 86_400_000 },
                    { windowMinutes: 300, usedPercent, resetsAt },
                ],
            },
        });
    }

    it('follows the displayed shortest window across the Usage page warning threshold', () => {
        expect(agentUsageLimitTone(withShortest(89.4), NOW)).toBeUndefined();
        expect(agentUsageLimitTone(withShortest(89.6), NOW)).toBe('warning');
        expect(agentUsageLimitTone(withShortest(100), NOW)).toBe('warning');
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
