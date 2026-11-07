import type { AgentActivityState, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { sessionStatus, summarizeSessionStatuses } from '../session-status';

type StatusSource = Pick<
    SessionRecord,
    'hasUnread' | 'hasPendingAttention' | 'agentActivityState' | 'lastAttentionKind'
>;

/**
 * Unread attention is always pending too (Mark as Done acknowledges it), so `hasUnread: true` implies pending unless a
 * case overrides it.
 */
function sessionSource(
    agentActivityState: AgentActivityState,
    overrides: Partial<StatusSource> = {},
): StatusSource {
    return {
        hasUnread: false,
        hasPendingAttention: overrides.hasUnread === true,
        agentActivityState,
        lastAttentionKind: undefined,
        ...overrides,
    };
}

describe('Session list status', () => {
    it('shows a live turn ahead of attention, as Activity files it under Working', () => {
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
            ariaDescription: 'The Agent is running.',
            ariaLabel: 'Working',
            kind: 'running',
            variant: 'active',
        });
        expect(
            sessionStatus(
                sessionSource('running', { hasUnread: true, lastAttentionKind: 'completed' }),
                { agentOperation: 'background' },
                translate,
            ),
        ).toMatchObject({ kind: 'running', variant: 'background' });
    });

    it('unread attention plays the arrival ripple; nothing marks it pending', () => {
        expect(
            sessionStatus(
                sessionSource('completed', { hasUnread: true, lastAttentionKind: 'completed' }),
                {},
                translate,
            ),
        ).toEqual({
            ariaDescription: 'The Agent finished its latest turn.',
            ariaLabel: 'Unread, finished',
            kind: 'attention',
            variant: 'result',
        });
    });

    it('keeps read Pending Attention amber until Mark as Done, without the arrival ripple', () => {
        const read = sessionSource('completed', {
            hasPendingAttention: true,
            lastAttentionKind: 'completed',
        });
        expect(sessionStatus(read, {}, translate)).toEqual({
            ariaDescription: 'The Agent finished its latest turn.',
            ariaLabel: 'Needs attention, finished',
            isPending: true,
            kind: 'attention',
            variant: 'result',
        });
        expect(
            sessionStatus(sessionSource('idle', { hasPendingAttention: true }), {}, translate),
        ).toMatchObject({ ariaLabel: 'Needs attention', isPending: true });
        // Mark as Done (or a new turn) resolves it.
        expect(sessionStatus({ ...read, hasPendingAttention: false }, {}, translate)).toEqual({
            kind: 'default',
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

    describe('a permission request only the user can decide', () => {
        it('stays amber after the Session is read, until the request leaves the feed', () => {
            const read = sessionSource('waiting', { lastAttentionKind: 'waiting' });
            expect(sessionStatus(read, {}, translate)).toEqual({ kind: 'default' });
            expect(sessionStatus(read, {}, translate, { approvalPending: true })).toEqual({
                ariaDescription: 'The Agent is waiting for input or confirmation.',
                ariaLabel: 'Waiting for you',
                isPending: true,
                kind: 'attention',
                variant: 'waiting',
            });
            expect(sessionStatus(read, {}, translate, { approvalPending: false })).toEqual({
                kind: 'default',
            });
        });

        it('does not depend on the Session record, so a Chat child with a stale idle state still shows it', () => {
            expect(
                sessionStatus(sessionSource('idle'), {}, translate, { approvalPending: true }),
            ).toMatchObject({ isPending: true, kind: 'attention', variant: 'waiting' });
        });

        it('leaves a Terminal Session with a stale waiting state clearing once read', () => {
            // The flag comes from the feed, which a Terminal child never has an approval in.
            expect(sessionStatus(sessionSource('waiting'), {}, translate)).toEqual({
                kind: 'default',
            });
            expect(
                sessionStatus(
                    sessionSource('waiting', { hasUnread: true, lastAttentionKind: 'waiting' }),
                    {},
                    translate,
                ),
            ).toMatchObject({ kind: 'attention', variant: 'waiting' });
        });

        it('keeps the animated unread cue while unread and outranks the running and detached glyphs', () => {
            const unread = sessionStatus(
                sessionSource('waiting', { hasUnread: true, lastAttentionKind: 'waiting' }),
                {},
                translate,
                { approvalPending: true },
            );
            expect(unread).toMatchObject({ kind: 'attention', variant: 'waiting' });
            expect(unread).not.toHaveProperty('isPending');
            expect(
                sessionStatus(sessionSource('running'), {}, translate, { approvalPending: true }),
            ).toMatchObject({ isPending: true, kind: 'attention' });
            expect(
                sessionStatus(
                    sessionSource('waiting'),
                    { lastProcessState: 'detached' },
                    translate,
                    {
                        approvalPending: true,
                    },
                ),
            ).toMatchObject({ isPending: true, kind: 'attention' });
        });
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
     * The amber slot follows Pending Attention only, never `agentActivityState` alone: a second amber state keyed off
     * it used to outlive resolution, which left a handled Session marked for as long as its Agent sat at an empty
     * prompt.
     */
    it.each<AgentActivityState>(['waiting', 'completed', 'failed', 'idle', 'running', 'unknown'])(
        'leaves a resolved %s Session unmarked',
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

describe('failed delegation status', () => {
    const failed = { delegationFailed: true };

    it('shows a read Session whose delegation failed as failed', () => {
        expect(sessionStatus(sessionSource('idle'), {}, translate, failed)).toEqual({
            ariaDescription: 'The delegated task failed.',
            ariaLabel: 'Delegation failed',
            kind: 'failed',
        });
    });

    it('does nothing without the flag, so only nested rows can read as failed', () => {
        expect(sessionStatus(sessionSource('idle'), {}, translate)).toEqual({ kind: 'default' });
        expect(
            sessionStatus(sessionSource('idle'), {}, translate, { delegationFailed: false }),
        ).toEqual({ kind: 'default' });
    });

    it('outranks an unread result, since the failure is what the news is about', () => {
        expect(
            sessionStatus(
                sessionSource('completed', { hasUnread: true, lastAttentionKind: 'completed' }),
                {},
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'failed' });
        expect(
            sessionStatus(sessionSource('idle', { hasUnread: true }), {}, translate, failed),
        ).toMatchObject({ kind: 'failed' });
    });

    it('yields to a detached Agent, which keeps its glyph', () => {
        expect(
            sessionStatus(
                sessionSource('idle'),
                { lastProcessState: 'detached' },
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'detached' });
    });

    it('yields to a usage-limit wait', () => {
        expect(
            sessionStatus(
                sessionSource('idle'),
                { usageLimitWaitAt: Date.UTC(2026, 9, 30, 12, 0) },
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'usageWait' });
    });

    it('yields to a pending approval request, which asks for the user right now', () => {
        expect(
            sessionStatus(
                sessionSource('waiting', { hasUnread: true, lastAttentionKind: 'waiting' }),
                {},
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'attention', variant: 'waiting' });
    });

    it('yields to a turn that is running or compacting, such as a follow-up after the failure', () => {
        expect(sessionStatus(sessionSource('running'), {}, translate, failed)).toMatchObject({
            kind: 'running',
        });
        expect(
            sessionStatus(
                sessionSource('idle'),
                { agentOperation: 'compacting' },
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'running' });
        // A live turn outranks unread news about the earlier one as well.
        expect(
            sessionStatus(
                sessionSource('running', { hasUnread: true, lastAttentionKind: 'completed' }),
                {},
                translate,
                failed,
            ),
        ).toMatchObject({ kind: 'running' });
    });

    it('stays out of the Project heading counts', () => {
        expect(
            summarizeSessionStatuses(
                [sessionSource('idle'), sessionSource('running')],
                () => {},
                translate,
            ),
        ).toEqual({ attention: 0, running: 1 });
    });
});

describe('summarizeSessionStatuses', () => {
    it('counts running and attention Sessions with the same projection as their rows', () => {
        const sessions = [
            sessionSource('running'),
            sessionSource('idle', { hasUnread: true, lastAttentionKind: 'completed' }),
            // Running outranks unread, so this Session counts as running only.
            sessionSource('running', { hasUnread: true, lastAttentionKind: 'completed' }),
            sessionSource('idle'),
            // Read but not marked Done still counts as attention.
            sessionSource('idle', { hasPendingAttention: true, lastAttentionKind: 'completed' }),
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
        ).toEqual({ attention: 2, running: 3 });
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
