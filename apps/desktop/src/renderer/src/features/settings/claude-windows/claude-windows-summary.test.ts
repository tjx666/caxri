import type { ClaudeWindowState } from '@caxri/protocol';
import { interpolate } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { enResources } from '../../../i18n/locales/en';
import {
    formatMinuteOfDay,
    formatWindowTime,
    parseTimeInput,
    summarizeClaudeWindows,
    warmUpMinuteOfDay,
} from './claude-windows-summary';

const english: Record<string, string> = enResources;
const t: Translate = (key, parameters) => interpolate(english[key] ?? key, parameters);
const NOW = new Date(2026, 9, 26, 12, 0).getTime();

const state: ClaudeWindowState = {
    account: {
        key: 'k',
        planType: 'pro',
        keepRolling: true,
        keepRollingIsDefault: true,
        firstWorkdayResetMinutes: 600,
    },
    status: 'windowActive',
    windowResetsAt: new Date(2026, 9, 26, 15, 0).getTime(),
    background: 'registered',
    checkedAt: NOW,
    wakeTimes: [],
};

describe('Claude windows card', () => {
    it('reads and writes the time input and derives the warm-up five hours earlier', () => {
        expect(formatMinuteOfDay(600)).toBe('10:00');
        expect(formatMinuteOfDay(65)).toBe('01:05');
        expect(parseTimeInput('08:30')).toBe(510);
        expect(parseTimeInput('24:00')).toBeUndefined();
        expect(parseTimeInput('')).toBeUndefined();
        expect(warmUpMinuteOfDay(600)).toBe(300);
        expect(warmUpMinuteOfDay(120)).toBe(1_260);
    });

    it('names the day of a time relative to now', () => {
        expect(formatWindowTime(t, new Date(2026, 9, 26, 5, 0).getTime(), NOW)).toBe('Today 05:00');
        expect(formatWindowTime(t, new Date(2026, 9, 27, 10, 1).getTime(), NOW)).toBe(
            'Tomorrow 10:01',
        );
        expect(formatWindowTime(t, new Date(2026, 9, 29, 5, 0).getTime(), NOW)).toBe('10/29 05:00');
    });

    it('summarizes status, a paused reason, the last outcome, and a background warning only while on', () => {
        expect(summarizeClaudeWindows(t, state, NOW)).toEqual({
            status: 'Window active, resets Today 15:00',
            isProblem: false,
        });
        expect(
            summarizeClaudeWindows(
                t,
                { ...state, status: 'unavailable', reason: 'authUnsupported' },
                NOW,
            ),
        ).toMatchObject({
            status: 'Paused: Claude Code uses an API key or another provider, which would bill API usage',
            isProblem: true,
        });
        expect(
            summarizeClaudeWindows(
                t,
                {
                    ...state,
                    background: 'registerFailed',
                    lastOutcome: {
                        outcome: 'trigger_confirmed',
                        at: new Date(2026, 9, 26, 7, 30).getTime(),
                        missedPlannedAt: new Date(2026, 9, 26, 5, 0).getTime(),
                    },
                },
                NOW,
            ),
        ).toMatchObject({
            lastOutcome:
                'Started a window · Today 07:30 (planned for Today 05:00, missed while asleep)',
            backgroundWarning: expect.stringContaining('Could not register') as string,
        });
        expect(
            summarizeClaudeWindows(
                t,
                {
                    ...state,
                    lastOutcome: {
                        outcome: 'trigger_confirmed',
                        at: new Date(2026, 9, 26, 5, 0).getTime(),
                    },
                },
                NOW,
            ).lastOutcome,
        ).toBe('Started a window · Today 05:00');
        expect(
            summarizeClaudeWindows(
                t,
                {
                    ...state,
                    account: { ...state.account!, keepRolling: false },
                    background: 'unpackaged',
                },
                NOW,
            ).backgroundWarning,
        ).toBeUndefined();
    });
});
