import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';
import { MAX_DELEGATION_ATTENTION_ITEMS } from '../delegation/agent-delegation-sessions.js';
import {
    collapseRetryChains,
    delegationAttentionKind,
    isDelegationFailed,
    isDelegationNeedsInput,
    isDelegationRetryPending,
} from '../delegation/attention/predicates.js';

const question = { questionId: 'q1', askedAt: 5, escalated: true };
const approval = { requestId: 'r1', kind: 'command', requestedAt: 5 } as never;

describe('delegationAttentionKind', () => {
    it.each([
        [
            'an approval waiting on the user',
            { status: 'blocked', approval, waitingOn: 'user' },
            'approval',
        ],
        ['an escalated question', { status: 'running', question, waitingOn: 'user' }, 'question'],
        [
            'a blocked permission prompt with no summary',
            { status: 'blocked', failure: 'permission_required' },
            'input',
        ],
        ['a first-run prompt', { status: 'blocked', failure: 'startup_waiting' }, 'input'],
        ['a real failure', { status: 'failed', failure: 'quota_exhausted' }, 'failed'],
        ['a failure with no recorded cause', { status: 'failed' }, 'failed'],
    ] as const)('names %s', (_name, entry, kind) => {
        expect(delegationAttentionKind(entry as never)).toBe(kind);
    });

    it.each([
        ['a running task', { status: 'running' }],
        ['a completed task', { status: 'completed' }],
        [
            'a question the delegating Agent still holds',
            { status: 'running', question, waitingOn: 'parent' },
        ],
        [
            'an approval the delegating Agent still holds',
            { status: 'blocked', approval, waitingOn: 'parent' },
        ],
        ['a user takeover', { status: 'failed', failure: 'human_input' }],
        ['a stop by the caller', { status: 'failed', failure: 'caller_stopped' }],
        [
            'a failure with a scheduled retry',
            { status: 'failed', failure: 'quota_exhausted', retriedAs: 'r', retryScheduledFor: 9 },
        ],
        [
            'a failure a retry replaced',
            { status: 'failed', failure: 'quota_exhausted', retriedAs: 'r' },
        ],
    ] as const)('names nothing for %s', (_name, entry) => {
        expect(delegationAttentionKind(entry as never)).toBeUndefined();
    });

    it('agrees with the failure and needs-input predicates it is built from', () => {
        for (const entry of [
            { status: 'failed', failure: 'quota_exhausted' },
            { status: 'blocked', failure: 'permission_required' },
            { status: 'running', waitingOn: 'user' },
        ] as const) {
            const kind = delegationAttentionKind(entry);
            expect(kind !== undefined).toBe(
                isDelegationFailed(entry as never) || isDelegationNeedsInput(entry as never),
            );
        }
        expect(isDelegationRetryPending({ retriedAs: 'r', retryScheduledFor: 9 })).toBe(true);
    });
});

describe('collapseRetryChains', () => {
    it('keeps only the newest attempt of a chain', () => {
        const entries = [
            { delegationId: 'a', retriedAs: 'b' },
            { delegationId: 'b', retryOf: 'a' },
        ];
        expect(collapseRetryChains(entries).map((entry) => entry.delegationId)).toEqual(['b']);
    });
});

describe('agent.delegation.attention', () => {
    const spec = methods['agent.delegation.attention'];

    it('is an owner-only read of one Session', () => {
        expect(spec.principal).toBe('owner');
        expect(spec.owner).toBe('server');
        expect(spec.effect).toBe('read');
        expect(spec.params.safeParse({ sessionId: 'root' }).success).toBe(true);
        expect(spec.params.safeParse({ sessionId: 'root', extra: 1 }).success).toBe(false);
    });

    it('parses an item with its branch and refuses text fields and an over-long list', () => {
        const item = {
            sessionId: 'c',
            createdBySessionId: 'b',
            relation: 'delegated',
            branchSessionId: 'b',
            status: 'blocked',
        };
        expect(spec.result.safeParse({ items: [item], isPartial: false }).success).toBe(true);
        expect(
            spec.result.safeParse({ items: [{ ...item, step: 'text' }], isPartial: false }).success,
        ).toBe(false);
        expect(
            spec.result.safeParse({
                items: [{ ...item, result: { summary: 's' } }],
                isPartial: false,
            }).success,
        ).toBe(false);
        expect(
            spec.result.safeParse({
                items: Array.from({ length: MAX_DELEGATION_ATTENTION_ITEMS + 1 }, () => item),
                isPartial: true,
            }).success,
        ).toBe(false);
    });
});
