import { describe, expect, it } from 'vitest';

import { agentChatPlanLimitRows } from '../agent-chat-plan-limits';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const HOUR = 3_600_000;

describe('agentChatPlanLimitRows', () => {
    it('lists live windows shortest first with what is left and when each resets', () => {
        const rows = agentChatPlanLimitRows(
            {
                provider: 'claude',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: 72.4, resetsAt: NOW + 98 * HOUR },
                    { windowMinutes: 300, usedPercent: 38, resetsAt: NOW + 3 * HOUR + 20 * 60_000 },
                ],
            },
            NOW,
        );
        expect(rows).toEqual([
            {
                key: '300',
                label: '5-hour limit',
                left: '62% left',
                leftPercent: 62,
                reset: 'Resets in 3h 20m',
                resetsAt: NOW + 3 * HOUR + 20 * 60_000,
                isWarning: false,
            },
            {
                key: '10080',
                label: 'Weekly limit',
                left: '28% left',
                leftPercent: 28,
                reset: 'Resets in 4d 2h',
                resetsAt: NOW + 98 * HOUR,
                isWarning: false,
            },
        ]);
    });

    it('warns near the limit, drops a reset window, and has no rows without a reading', () => {
        const rows = agentChatPlanLimitRows(
            {
                provider: 'codex',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 300, usedPercent: 99, resetsAt: NOW - 1 },
                    { windowMinutes: 10_080, usedPercent: 91 },
                ],
            },
            NOW,
        );
        expect(rows).toMatchObject([{ key: '10080', isWarning: true, reset: undefined }]);
        expect(agentChatPlanLimitRows(null, NOW)).toEqual([]);
    });
});
