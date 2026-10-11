import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentUsageLabel, currentLimitWindows, shortWindowName } from '../agent-usage-label';

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
