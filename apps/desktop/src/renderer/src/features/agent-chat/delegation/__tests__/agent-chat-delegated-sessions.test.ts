import type { AgentDelegationSession } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../../i18n';
import {
    DELEGATED_COMPLETED_VISIBLE_MS,
    delegatedOwnPullRequest,
    delegatedSessionLine,
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
    delegationPrFilesLabel,
    mergeDeeperAttention,
    sortDelegatedSessions,
    splitDelegatedSessions,
} from '../agent-chat-delegated-sessions';

const t = ((key: string, parameters?: Record<string, unknown>) =>
    parameters ? `${key}:${JSON.stringify(parameters)}` : key) as unknown as Translate;

function entry(overrides: Partial<AgentDelegationSession>): AgentDelegationSession {
    return {
        createdBySessionId: 'parent',
        relation: 'delegated',
        sessionId: 'child',
        ...overrides,
    };
}

describe('delegatedSessionsSummary', () => {
    it('counts needs-input and failed apart and leaves answer_unavailable out of both', () => {
        expect(
            delegatedSessionsSummary([
                entry({ failure: 'permission_required', status: 'blocked' }),
                entry({ failure: 'startup_waiting', status: 'blocked' }),
                entry({ failure: 'provider_failed', status: 'failed' }),
                entry({ status: 'answer_unavailable' }),
                entry({ status: 'running' }),
                entry({ status: 'blocked' }),
            ]),
        ).toEqual({ approvals: 0, asking: 0, failed: 1, needsInput: 2, total: 6, waiting: 0 });
    });
});

describe('mergeDeeperAttention', () => {
    const deeper = {
        branchSessionId: 'child',
        createdBySessionId: 'child',
        relation: 'delegated' as const,
        sessionId: 'grandchild',
        status: 'blocked' as const,
        failure: 'permission_required' as const,
    };

    it('ranks a deeper item that needs the user above a running direct child and names its branch', () => {
        const rows = mergeDeeperAttention([entry({ status: 'running' })], {
            items: [deeper],
            isPartial: false,
        });

        expect(rows.entries.map((row) => row.sessionId)).toEqual(['grandchild', 'child']);
        expect(rows.entries[0]).not.toHaveProperty('branchSessionId');
        expect(rows.viaBySessionId.get('grandchild')).toBe('child');
        expect(rows.viaBySessionId.has('child')).toBe(false);
        expect(rows.isPartial).toBe(false);
    });

    it('keeps the direct row when the roll-up also lists that Session, and passes isPartial through', () => {
        const rows = mergeDeeperAttention([entry({ sessionId: 'grandchild', status: 'running' })], {
            items: [deeper],
            isPartial: true,
        });

        expect(rows.entries).toHaveLength(1);
        expect(rows.entries[0]).toMatchObject({ status: 'running' });
        expect(rows.viaBySessionId.size).toBe(0);
        expect(rows.isPartial).toBe(true);
    });

    it('is the direct children alone before the roll-up has answered', () => {
        const rows = mergeDeeperAttention([entry({ status: 'running' })], undefined);

        expect(rows.entries).toHaveLength(1);
        expect(rows.isPartial).toBe(false);
    });

    it('counts deeper items as attention while the header keeps the direct total', () => {
        const rows = mergeDeeperAttention([entry({ status: 'running' })], {
            items: [deeper],
            isPartial: false,
        });

        expect(delegatedSessionsSummary(rows.entries, 1)).toEqual({
            approvals: 0,
            asking: 0,
            failed: 0,
            needsInput: 1,
            total: 1,
            waiting: 0,
        });
    });
});

describe('delegation questions in the strip', () => {
    it('counts asking tasks apart and words them, one or many', () => {
        const summary = delegatedSessionsSummary([
            entry({ status: 'running', waitingOn: 'parent' }),
            entry({ status: 'running', waitingOn: 'parent' }),
            entry({ status: 'running', waitingOn: 'user' }),
        ]);
        expect(summary).toMatchObject({ asking: 2, needsInput: 1 });
        expect(delegatedSessionsHeaderParts(summary, t)).toMatchObject({
            asking: 'delegation.strip.askingOther:{"count":2}',
            needsInput: 'delegation.strip.needsInputOne:{"count":1}',
        });
        const single = delegatedSessionsSummary([
            entry({ status: 'running', waitingOn: 'parent' }),
        ]);
        expect(delegatedSessionsHeaderParts(single, t).asking).toBe(
            'delegation.strip.askingOne:{"count":1}',
        );
    });

    it('omits the asking part without one', () => {
        const summary = delegatedSessionsSummary([entry({ status: 'running' })]);
        expect(delegatedSessionsHeaderParts(summary, t)).not.toHaveProperty('asking');
    });

    it('ranks an escalated question with needs-input and an unescalated one with the rest', () => {
        const asking = entry({ sessionId: 'asking', status: 'running', waitingOn: 'parent' });
        const escalated = entry({ sessionId: 'escalated', status: 'running', waitingOn: 'user' });
        const plain = entry({ sessionId: 'plain', status: 'running' });
        expect(
            sortDelegatedSessions([asking, plain, escalated]).map((row) => row.sessionId),
        ).toEqual(['escalated', 'asking', 'plain']);
    });
});

describe('delegatedSessionsSummary with a pending retry', () => {
    it('counts a failure whose retry is scheduled as waiting, not failed', () => {
        const pending = entry({
            failure: 'quota_exhausted',
            retriedAs: 'next',
            retryScheduledFor: 1_700_000_000_000,
            status: 'failed',
        });
        const summary = delegatedSessionsSummary([pending]);
        expect(summary).toEqual({
            approvals: 0,
            asking: 0,
            failed: 0,
            needsInput: 0,
            total: 1,
            waiting: 1,
        });
        expect(delegatedSessionsHeaderParts(summary, t)).toEqual({
            count: 'delegation.strip.count:{"count":1}',
            waiting: 'delegation.strip.retryWaitingOne:{"count":1}',
        });
    });
});

describe('delegation permission requests in the strip', () => {
    const escalated = (): AgentDelegationSession =>
        entry({
            approval: {
                covered: false,
                coverageReason: 'parent_mode_insufficient',
                escalated: true,
                kind: 'command',
                requestId: 'r1',
                requestedAt: 1,
            },
            failure: 'permission_required',
            status: 'blocked',
            waitingOn: 'user',
        });

    it('words escalated requests as waiting for the approval, and held ones as asking', () => {
        const summary = delegatedSessionsSummary([
            escalated(),
            entry({ failure: 'permission_required', status: 'blocked', waitingOn: 'parent' }),
        ]);
        expect(summary).toMatchObject({ approvals: 1, asking: 1, needsInput: 1 });
        expect(delegatedSessionsHeaderParts(summary, t)).toMatchObject({
            asking: 'delegation.strip.askingOne:{"count":1}',
            needsInput: 'delegation.strip.approvalOne:{"count":1}',
        });
    });

    it('falls back to needs input when a plain question or startup prompt waits beside the approval', () => {
        const summary = delegatedSessionsSummary([
            escalated(),
            escalated(),
            entry({ failure: 'startup_waiting', status: 'blocked' }),
        ]);
        expect(delegatedSessionsHeaderParts(summary, t).needsInput).toBe(
            'delegation.strip.needsInputOther:{"count":3}',
        );
        const approvals = delegatedSessionsSummary([escalated(), escalated()]);
        expect(delegatedSessionsHeaderParts(approvals, t).needsInput).toBe(
            'delegation.strip.approvalOther:{"count":2}',
        );
    });
});

describe('delegatedSessionsHeaderParts', () => {
    it('states only the attention parts that have a count, with singular and plural needs-input', () => {
        expect(
            delegatedSessionsHeaderParts(
                { approvals: 0, asking: 0, failed: 0, needsInput: 0, total: 3, waiting: 0 },
                t,
            ),
        ).toEqual({
            count: 'delegation.strip.count:{"count":3}',
        });
        expect(
            delegatedSessionsHeaderParts(
                { approvals: 0, asking: 0, failed: 2, needsInput: 1, total: 3, waiting: 0 },
                t,
            ),
        ).toEqual({
            count: 'delegation.strip.count:{"count":3}',
            failed: 'delegation.strip.failed:{"count":2}',
            needsInput: 'delegation.strip.needsInputOne:{"count":1}',
        });
        expect(
            delegatedSessionsHeaderParts(
                { approvals: 0, asking: 0, failed: 0, needsInput: 2, total: 3, waiting: 0 },
                t,
            ).needsInput,
        ).toBe('delegation.strip.needsInputOther:{"count":2}');
        expect(
            delegatedSessionsHeaderParts(
                { approvals: 0, asking: 0, failed: 0, needsInput: 0, total: 3, waiting: 2 },
                t,
            ).waiting,
        ).toBe('delegation.strip.retryWaitingOther:{"count":2}');
    });
});

describe('sortDelegatedSessions', () => {
    it('puts needs-input first, failures second, open work before completed, and keeps the Server order within a group', () => {
        const rows = [
            entry({ sessionId: 'a', status: 'completed' }),
            entry({ sessionId: 'b', status: 'failed' }),
            entry({ sessionId: 'c', status: 'running' }),
            entry({ failure: 'permission_required', sessionId: 'd', status: 'blocked' }),
            entry({ sessionId: 'e', status: 'completed' }),
            entry({ sessionId: 'f', status: 'interrupted' }),
        ];
        expect(sortDelegatedSessions(rows).map((row) => row.sessionId)).toEqual([
            'd',
            'b',
            'c',
            'f',
            'a',
            'e',
        ]);
    });
});

describe('splitDelegatedSessions', () => {
    const now = 1_000_000_000;

    it('folds completed rows past the visible window and keeps recent ones and open work in view', () => {
        const rows = [
            entry({ sessionId: 'running', status: 'running' }),
            entry({ sessionId: 'recent', settledAt: now - 60_000, status: 'completed' }),
            entry({
                sessionId: 'old',
                settledAt: now - DELEGATED_COMPLETED_VISIBLE_MS,
                status: 'completed',
            }),
            entry({ sessionId: 'failed', settledAt: now - 3_600_000, status: 'failed' }),
        ];
        const split = splitDelegatedSessions(rows, now);
        expect(split.shown.map((row) => row.sessionId)).toEqual(['running', 'recent', 'failed']);
        expect(split.folded.map((row) => row.sessionId)).toEqual(['old']);
        expect(split.hasRecentCompleted).toBe(true);
    });

    it("falls back to the result's completion time and folds a row with no time at all", () => {
        const result = {
            completedAt: now - 1000,
            delegationId: 'task',
            source: 'authored' as const,
            summary: 'Done',
        };
        const split = splitDelegatedSessions(
            [
                entry({ result, sessionId: 'by-result', status: 'completed' }),
                entry({ sessionId: 'untimed', status: 'completed' }),
            ],
            now,
        );
        expect(split.shown.map((row) => row.sessionId)).toEqual(['by-result']);
        expect(split.folded.map((row) => row.sessionId)).toEqual(['untimed']);
    });

    it('never folds a completed row that waits on the user, and needs no clock without a recent row', () => {
        const split = splitDelegatedSessions(
            [entry({ sessionId: 'question', status: 'completed', waitingOn: 'user' })],
            now,
        );
        expect(split.shown.map((row) => row.sessionId)).toEqual(['question']);
        expect(split.folded).toEqual([]);
        expect(split.hasRecentCompleted).toBe(false);
    });
});

describe('delegatedSessionLine', () => {
    const working = { glyph: 'running', headline: 'Working' } as const;
    const done = { glyph: 'ordinary', headline: 'Completed' } as const;
    const result = {
        completedAt: 5,
        delegationId: 'd1',
        source: 'excerpt',
        summary: 'It works.',
    } as const;

    it('shows the live step of an active task, or the status without one', () => {
        expect(
            delegatedSessionLine(entry({ status: 'running', step: 'Reading' }), working),
        ).toEqual({ kind: 'step', text: 'Reading' });
        expect(delegatedSessionLine(entry({ status: 'running' }), working)).toEqual({
            kind: 'status',
            text: 'Working',
        });
    });

    it('shows the summary only when it belongs to the newest task, marking an excerpt', () => {
        expect(
            delegatedSessionLine(entry({ delegationId: 'd1', result, status: 'completed' }), done),
        ).toEqual({ isExcerpt: true, kind: 'summary', text: 'It works.' });
        expect(
            delegatedSessionLine(
                entry({
                    delegationId: 'd1',
                    result: { ...result, source: 'authored' },
                    status: 'completed',
                }),
                done,
            ),
        ).toMatchObject({ isExcerpt: false, kind: 'summary' });
        expect(
            delegatedSessionLine(entry({ delegationId: 'd2', result, status: 'completed' }), done),
        ).toEqual({ kind: 'status', text: 'Completed' });
    });

    it('carries the status detail for a failure', () => {
        expect(
            delegatedSessionLine(entry({ status: 'failed' }), {
                detail: 'Sign in',
                glyph: 'failed',
                headline: 'Failed',
            }),
        ).toEqual({ detail: 'Sign in', kind: 'status', text: 'Failed' });
    });
});

describe('delegationPrFilesLabel', () => {
    it('labels a positive count as the whole pull request and omits an unknown one', () => {
        expect(delegationPrFilesLabel(12, t)).toBe('delegation.strip.prFilesOther:{"count":12}');
        expect(delegationPrFilesLabel(1, t)).toBe('delegation.strip.prFilesOne:{"count":1}');
        expect(delegationPrFilesLabel(undefined, t)).toBeUndefined();
        expect(delegationPrFilesLabel(0, t)).toBeUndefined();
        expect(delegationPrFilesLabel(-3, t)).toBeUndefined();
    });
});

describe('delegatedOwnPullRequest', () => {
    const own = { url: 'https://github.com/owner/example/pull/2' };
    const parent = { url: 'https://github.com/owner/example/pull/1' };

    it("hides the delegating Session's pull request a task worked on", () => {
        expect(delegatedOwnPullRequest({ ...parent }, parent)).toBeUndefined();
    });

    it("keeps the task's own pull request", () => {
        expect(delegatedOwnPullRequest(own, parent)).toBe(own);
        expect(delegatedOwnPullRequest(own, undefined)).toBe(own);
    });

    it('shows nothing without a pull request', () => {
        expect(delegatedOwnPullRequest(undefined, parent)).toBeUndefined();
    });
});
