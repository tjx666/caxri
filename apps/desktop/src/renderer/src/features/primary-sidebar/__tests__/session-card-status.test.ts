import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { sessionCardStatusLine } from '../session-card-status';

const settled = {
    hasUnread: false,
    agentActivityState: 'idle',
    lastAttentionKind: undefined,
} as const;

describe('Session hover card status line', () => {
    it('adds no line for a settled Session', () => {
        expect(sessionCardStatusLine(settled, undefined, translate)).toBeUndefined();
    });

    it('names a running Session', () => {
        expect(
            sessionCardStatusLine(
                { ...settled, agentActivityState: 'running' },
                undefined,
                translate,
            ),
        ).toBe('Working');
    });

    it('names unread attention with its kind', () => {
        expect(
            sessionCardStatusLine(
                {
                    ...settled,
                    hasUnread: true,
                    agentActivityState: 'waiting',
                    lastAttentionKind: 'waiting',
                },
                undefined,
                translate,
            ),
        ).toBe('Unread, waiting for you');
    });

    it('names a detached Agent', () => {
        expect(sessionCardStatusLine(settled, { lastProcessState: 'detached' }, translate)).toBe(
            'Detached',
        );
    });
});
