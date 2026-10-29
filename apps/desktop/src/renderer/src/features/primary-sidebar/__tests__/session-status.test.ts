import type { AgentActivityState, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { sessionStatus, summarizeSessionStatuses } from '../session-status';

function sessionSource(
    agentActivityState: AgentActivityState,
    overrides: Partial<
        Pick<SessionRecord, 'hasUnread' | 'agentActivityState' | 'lastAttentionKind'>
    > = {},
): Pick<SessionRecord, 'hasUnread' | 'agentActivityState' | 'lastAttentionKind'> {
    return {
        hasUnread: false,
        agentActivityState,
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
                {},
                translate,
            ),
        ).toEqual({
            ariaDescription: 'The Agent finished its latest turn. Current status: Working.',
            ariaLabel: 'Unread, finished',
            kind: 'attention',
            variant: 'result',
        });
    });

    it('shows the wait for a usage limit ahead of unread attention and a failed turn', () => {
        const usageLimitWaitAt = Date.UTC(2026, 9, 30, 12, 0);
        const status = sessionStatus(
            sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
            { usageLimitWaitAt },
            translate,
        );
        expect(status).toMatchObject({
            ariaLabel: 'Waiting for limit reset',
            kind: 'usageWait',
        });
        expect(status).toHaveProperty(
            'ariaDescription',
            expect.stringMatching(/^Continues automatically at \d/) as string,
        );
        // The wait ends: the unread failure shows again.
        expect(
            sessionStatus(
                sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
                {},
                translate,
            ),
        ).toMatchObject({ kind: 'attention' });
    });

    it('keeps the unread name short for waiting and unknown attention', () => {
        expect(
            sessionStatus(
                sessionSource('waiting', { hasUnread: true, lastAttentionKind: 'waiting' }),
                {},
                translate,
            ),
        ).toMatchObject({
            ariaDescription: 'The Agent is waiting for input or confirmation.',
            ariaLabel: 'Unread, waiting for you',
            variant: 'waiting',
        });
        expect(
            sessionStatus(sessionSource('idle', { hasUnread: true }), {}, translate),
        ).toMatchObject({
            ariaLabel: 'Unread',
            variant: 'result',
        });
    });

    /**
     * The amber slot is a call to open the Session, so reading it is the only thing that clears it and nothing else may
     * bring it back. A second static amber state keyed off `agentActivityState` used to outlive acknowledgement, which
     * left an already-read Session marked for as long as its Agent sat at an empty prompt.
     */
    it.each<AgentActivityState>(['waiting', 'completed', 'failed', 'idle', 'running', 'unknown'])(
        'leaves an acknowledged %s Session unmarked',
        (state) => {
            const acknowledged = sessionSource(state, {
                hasUnread: false,
                lastAttentionKind: 'completed',
            });

            expect(sessionStatus(acknowledged, {}, translate)).not.toMatchObject({
                kind: 'attention',
            });
        },
    );

    it('maps running and compaction to the running slot', () => {
        expect(sessionStatus(sessionSource('running'), {}, translate)).toEqual({
            ariaDescription: 'The Agent is running.',
            ariaLabel: 'Working',
            kind: 'running',
            variant: 'active',
        });
        expect(
            sessionStatus(sessionSource('completed'), { agentOperation: 'compacting' }, translate),
        ).toEqual({
            ariaDescription: 'The Agent is summarizing earlier context before continuing.',
            ariaLabel: 'Compacting',
            kind: 'running',
            variant: 'active',
        });
    });

    it('shows a turn waiting on background work as the quiet running variant', () => {
        expect(
            sessionStatus(sessionSource('running'), { agentOperation: 'background' }, translate),
        ).toEqual({
            ariaDescription:
                'The turn ended while background work it started is still running; the Agent continues once that work reports back.',
            ariaLabel: 'In background',
            kind: 'running',
            variant: 'background',
        });
    });

    it.each<AgentActivityState>(['completed', 'failed', 'idle', 'unknown', 'waiting'])(
        'maps a read %s lifecycle state to the blank default slot',
        (state) => {
            expect(sessionStatus(sessionSource(state), {}, translate)).toEqual({ kind: 'default' });
        },
    );

    it('shows a detached Agent as a static detached slot instead of stale activity', () => {
        expect(
            sessionStatus(sessionSource('running'), { lastProcessState: 'detached' }, translate),
        ).toEqual({
            ariaDescription: 'The Agent was stopped so another client can resume it.',
            ariaLabel: 'Detached',
            kind: 'detached',
        });
        expect(
            sessionStatus(sessionSource('waiting'), { lastProcessState: 'detached' }, translate),
        ).toEqual({
            ariaDescription: 'The Agent was stopped so another client can resume it.',
            ariaLabel: 'Detached',
            kind: 'detached',
        });
    });

    it('keeps unread attention ahead of a detached Agent', () => {
        expect(
            sessionStatus(
                sessionSource('completed', { hasUnread: true, lastAttentionKind: 'completed' }),
                { lastProcessState: 'detached' },
                translate,
            ),
        ).toMatchObject({ kind: 'attention' });
    });

    it('gives failed attention the result shape, since there is nothing to answer', () => {
        expect(
            sessionStatus(
                sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
                {},
                translate,
            ),
        ).toMatchObject({ kind: 'attention', variant: 'result' });
    });

    it('keeps reliable failed attention in the unified unread state', () => {
        expect(
            sessionStatus(
                sessionSource('failed', { hasUnread: true, lastAttentionKind: 'failed' }),
                {},
                translate,
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
            summarizeSessionStatuses(
                sessions,
                (session) =>
                    session === compacting ? { agentOperation: 'compacting' } : undefined,
                translate,
            ),
        ).toEqual({ attention: 2, running: 2 });
    });

    it('leaves a detached Agent out of the running count', () => {
        expect(
            summarizeSessionStatuses(
                [sessionSource('running')],
                () => ({
                    lastProcessState: 'detached',
                }),
                translate,
            ),
        ).toEqual({ attention: 0, running: 0 });
    });
});
