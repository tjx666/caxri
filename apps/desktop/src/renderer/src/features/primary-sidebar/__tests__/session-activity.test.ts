import type { AgentActivityState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    sessionActivityPresentation,
    sessionStatusLineActivity,
    sessionUnreadTone,
} from '../session-activity';

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

    it('presents compaction as a successful Working subphase', () => {
        expect(sessionActivityPresentation('running', 'compacting')).toEqual({
            ariaLabel: 'Compacting. Codex is summarizing earlier context before continuing.',
            description: 'Codex is summarizing earlier context before continuing.',
            indicatorClassName: 'text-success',
            label: 'Compacting',
            tone: 'success',
        });
    });

    it.each<[AgentActivityState, 'danger' | 'warning']>([
        ['waiting', 'warning'],
        ['completed', 'warning'],
        ['idle', 'warning'],
        ['unknown', 'warning'],
        ['running', 'warning'],
        ['failed', 'danger'],
    ])('resolves the %s unread detail to a non-neutral tone', (kind, tone) => {
        expect(sessionUnreadTone(kind)).toBe(tone);
    });
});

describe('Session status line activity', () => {
    it('names the current activity, with compaction and detachment overriding the stored state', () => {
        expect(sessionStatusLineActivity({ lastActivityState: 'running' })?.label).toBe('Working');
        expect(
            sessionStatusLineActivity(
                { lastActivityState: 'running' },
                { agentOperation: 'compacting' },
            )?.label,
        ).toBe('Compacting');
        expect(
            sessionStatusLineActivity(
                { lastActivityState: 'running' },
                { lastProcessState: 'detached' },
            )?.label,
        ).toBe('Detached');
    });

    it('leaves a Session that never reported activity to show only its time', () => {
        expect(sessionStatusLineActivity({ lastActivityState: 'unknown' })).toBeUndefined();
    });
});
