import type { AgentActivityState, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionStatus } from '../session-status';

function sessionSource(
    lastActivityState: AgentActivityState,
    overrides: Partial<
        Pick<SessionRecord, 'hasUnread' | 'lastActivityState' | 'lastAttentionKind'>
    > = {},
): Pick<SessionRecord, 'hasUnread' | 'lastActivityState' | 'lastAttentionKind'> {
    return {
        hasUnread: false,
        lastActivityState,
        lastAttentionKind: undefined,
        ...overrides,
    };
}

describe('Session list status', () => {
    it('shows unread attention ahead of current running activity', () => {
        expect(
            sessionStatus(
                sessionSource('running', {
                    hasUnread: true,
                    lastAttentionKind: 'completed',
                }),
                undefined,
                true,
            ),
        ).toEqual({
            ariaLabel:
                'Needs attention: Finished. The Agent finished its latest turn. Current status: Working. The Agent is running.',
            emphasis: 'unread',
            kind: 'attention',
        });
    });

    it('keeps acknowledged waiting visible without unread emphasis', () => {
        expect(sessionStatus(sessionSource('waiting'))).toEqual({
            ariaLabel:
                'Needs attention. Waiting for you. The Agent is waiting for input or confirmation.',
            emphasis: 'persistent',
            kind: 'attention',
        });
    });

    it('clears acknowledged waiting from the selected Session row', () => {
        expect(sessionStatus(sessionSource('waiting'), undefined, true)).toEqual({
            kind: 'default',
        });
    });

    it('maps running and compaction to the running slot', () => {
        expect(sessionStatus(sessionSource('running'))).toEqual({
            ariaLabel: 'Working. The Agent is running.',
            kind: 'running',
        });
        expect(sessionStatus(sessionSource('running'), undefined, true)).toEqual({
            ariaLabel: 'Working. The Agent is running.',
            kind: 'running',
        });
        expect(sessionStatus(sessionSource('completed'), 'compacting')).toEqual({
            ariaLabel: 'Compacting. Codex is summarizing earlier context before continuing.',
            kind: 'running',
        });
    });

    it.each<AgentActivityState>(['completed', 'failed', 'idle', 'unknown'])(
        'maps a read %s lifecycle state to the blank default slot',
        (state) => {
            expect(sessionStatus(sessionSource(state))).toEqual({ kind: 'default' });
        },
    );

    it('keeps reliable failed attention in the unified unread state', () => {
        expect(
            sessionStatus(
                sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
            ),
        ).toMatchObject({ emphasis: 'unread', kind: 'attention' });
    });
});
