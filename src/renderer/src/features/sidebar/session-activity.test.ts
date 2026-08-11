import { describe, expect, it } from 'vitest';

import type { AgentActivityState } from '@shared/types';

import { formatSessionRelativeTime } from './SessionActivityCard';
import { sessionActivityPresentation } from './session-activity';

describe('Session activity presentation', () => {
    it.each<
        [AgentActivityState, string, string, 'danger' | 'neutral' | 'success' | 'warning', string]
    >([
        ['running', 'Working', 'The Agent is running.', 'success', 'text-success'],
        [
            'waiting',
            'Waiting for you',
            'The Agent is waiting for input or confirmation.',
            'warning',
            'text-warning',
        ],
        [
            'failed',
            'Failed',
            'The latest reliable Agent state is a failure.',
            'danger',
            'text-danger',
        ],
        ['completed', 'Finished', 'The Agent finished its latest turn.', 'neutral', 'text-muted'],
        ['idle', 'Idle', 'The Agent is currently idle.', 'neutral', 'text-muted'],
        [
            'unknown',
            'No activity reported',
            'No reliable Agent activity is available.',
            'neutral',
            'text-muted',
        ],
    ])('maps %s to one complete presentation', (state, label, description, tone, className) => {
        expect(sessionActivityPresentation(state)).toEqual({
            ariaLabel: `${label}. ${description}`,
            description,
            indicatorClassName: className,
            label,
            tone,
        });
    });

    it('labels Session recency as last-opened relative time', () => {
        const now = Date.UTC(2026, 7, 11, 8);

        expect(formatSessionRelativeTime(now - 2 * 3_600_000, now)).toBe('2 hours ago');
        expect(formatSessionRelativeTime(now + 60_000, now)).toBe('in 1 minute');
    });
});
