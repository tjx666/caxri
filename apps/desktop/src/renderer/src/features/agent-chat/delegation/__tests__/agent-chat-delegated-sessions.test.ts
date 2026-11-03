import type { AgentDelegationSession } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../../i18n';
import {
    delegatedSessionLine,
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
    delegationPrFilesLabel,
    sortDelegatedSessions,
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
        ).toEqual({ failed: 1, needsInput: 2, total: 6, waiting: 0 });
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
        expect(summary).toEqual({ failed: 0, needsInput: 0, total: 1, waiting: 1 });
        expect(delegatedSessionsHeaderParts(summary, t)).toEqual({
            count: 'delegation.strip.count:{"count":1}',
            waiting: 'delegation.strip.retryWaitingOne:{"count":1}',
        });
    });
});

describe('delegatedSessionsHeaderParts', () => {
    it('states only the attention parts that have a count, with singular and plural needs-input', () => {
        expect(
            delegatedSessionsHeaderParts({ failed: 0, needsInput: 0, total: 3, waiting: 0 }, t),
        ).toEqual({
            count: 'delegation.strip.count:{"count":3}',
        });
        expect(
            delegatedSessionsHeaderParts({ failed: 2, needsInput: 1, total: 3, waiting: 0 }, t),
        ).toEqual({
            count: 'delegation.strip.count:{"count":3}',
            failed: 'delegation.strip.failed:{"count":2}',
            needsInput: 'delegation.strip.needsInputOne:{"count":1}',
        });
        expect(
            delegatedSessionsHeaderParts({ failed: 0, needsInput: 2, total: 3, waiting: 0 }, t)
                .needsInput,
        ).toBe('delegation.strip.needsInputOther:{"count":2}');
        expect(
            delegatedSessionsHeaderParts({ failed: 0, needsInput: 0, total: 3, waiting: 2 }, t)
                .waiting,
        ).toBe('delegation.strip.retryWaitingOther:{"count":2}');
    });
});

describe('sortDelegatedSessions', () => {
    it('puts needs-input first, failures second, and keeps the Server order within a group', () => {
        const rows = [
            entry({ sessionId: 'a', status: 'completed' }),
            entry({ sessionId: 'b', status: 'failed' }),
            entry({ sessionId: 'c', status: 'running' }),
            entry({ failure: 'permission_required', sessionId: 'd', status: 'blocked' }),
        ];
        expect(sortDelegatedSessions(rows).map((row) => row.sessionId)).toEqual([
            'd',
            'b',
            'a',
            'c',
        ]);
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
