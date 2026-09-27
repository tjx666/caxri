import type { AgentActivityState, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionStatus, summarizeSessionStatuses } from '../session-status';

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
            ),
        ).toEqual({
            ariaLabel:
                'Needs attention: Finished. The Agent finished its latest turn. Current status: Working. The Agent is running.',
            kind: 'attention',
        });
    });

    /**
     * The amber slot is a call to open the Session, so reading it is the only thing that clears it and nothing else may
     * bring it back. A second static amber state keyed off `lastActivityState` used to outlive acknowledgement, which
     * left an already-read Session marked for as long as its Agent sat at an empty prompt.
     */
    it.each<AgentActivityState>(['waiting', 'completed', 'failed', 'idle', 'running', 'unknown'])(
        'leaves an acknowledged %s Session unmarked',
        (state) => {
            const acknowledged = sessionSource(state, {
                hasUnread: false,
                lastAttentionKind: 'completed',
            });

            expect(sessionStatus(acknowledged)).not.toMatchObject({ kind: 'attention' });
        },
    );

    it('maps running and compaction to the running slot', () => {
        expect(sessionStatus(sessionSource('running'))).toEqual({
            ariaLabel: 'Working. The Agent is running.',
            kind: 'running',
        });
        expect(sessionStatus(sessionSource('completed'), { agentOperation: 'compacting' })).toEqual(
            {
                ariaLabel: 'Compacting. Codex is summarizing earlier context before continuing.',
                kind: 'running',
            },
        );
    });

    it.each<AgentActivityState>(['completed', 'failed', 'idle', 'unknown', 'waiting'])(
        'maps a read %s lifecycle state to the blank default slot',
        (state) => {
            expect(sessionStatus(sessionSource(state))).toEqual({ kind: 'default' });
        },
    );

    it('shows a detached Agent as a static detached slot instead of stale activity', () => {
        expect(sessionStatus(sessionSource('running'), { lastProcessState: 'detached' })).toEqual({
            ariaLabel: 'Detached. The Agent was stopped so another client can resume it.',
            kind: 'detached',
        });
        expect(sessionStatus(sessionSource('waiting'), { lastProcessState: 'detached' })).toEqual({
            ariaLabel: 'Detached. The Agent was stopped so another client can resume it.',
            kind: 'detached',
        });
    });

    it('keeps unread attention ahead of a detached Agent', () => {
        expect(
            sessionStatus(
                sessionSource('completed', { hasUnread: true, lastAttentionKind: 'completed' }),
                { lastProcessState: 'detached' },
            ),
        ).toMatchObject({ kind: 'attention' });
    });

    it('keeps reliable failed attention in the unified unread state', () => {
        expect(
            sessionStatus(
                sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
            ),
        ).toMatchObject({ kind: 'attention' });
    });
});

describe('summarizeSessionStatuses', () => {
    it('counts running and unread Sessions with the same projection as their rows', () => {
        const sessions = [
            sessionSource('running'),
            sessionSource('idle', { hasUnread: true, lastAttentionKind: 'completed' }),
            // Unread outranks running, so this Session counts as attention only.
            sessionSource('running', { hasUnread: true, lastAttentionKind: 'completed' }),
            sessionSource('idle'),
            sessionSource('idle'),
        ];
        const compacting = sessions[3];
        expect(
            summarizeSessionStatuses(sessions, (session) =>
                session === compacting ? { agentOperation: 'compacting' } : undefined,
            ),
        ).toEqual({ attention: 2, running: 2 });
    });

    it('leaves a detached Agent out of the running count', () => {
        expect(
            summarizeSessionStatuses([sessionSource('running')], () => ({
                lastProcessState: 'detached',
            })),
        ).toEqual({ attention: 0, running: 0 });
    });
});
