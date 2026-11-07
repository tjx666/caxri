import { describe, expect, it } from 'vitest';

import type { SessionActivityRowOrder } from '../session-activity-group';
import {
    compareSessionActivityGroupRows,
    isSessionAgentRunning,
    sessionActivityGroup,
} from '../session-activity-group';

const session = (overrides: Partial<Parameters<typeof sessionActivityGroup>[0]> = {}) => ({
    hasPendingAttention: false,
    isDetached: false,
    isRunning: false,
    ...overrides,
});

describe('isSessionAgentRunning', () => {
    it('counts a running turn or a compaction, and nothing else', () => {
        expect(isSessionAgentRunning({ agentActivityState: 'running' }, undefined)).toBe(true);
        expect(
            isSessionAgentRunning({ agentActivityState: 'idle' }, { agentOperation: 'compacting' }),
        ).toBe(true);
        expect(
            isSessionAgentRunning({ agentActivityState: 'idle' }, { agentOperation: 'background' }),
        ).toBe(false);
        expect(isSessionAgentRunning({ agentActivityState: 'completed' }, {})).toBe(false);
    });
});

describe('sessionActivityGroup', () => {
    it('keeps a Session with Pending Attention under attention whether or not it was read', () => {
        expect(sessionActivityGroup(session({ hasPendingAttention: true }))).toBe('attention');
        expect(sessionActivityGroup(session())).toBe('idle');
    });

    it('lists a running Agent under working even while it still has Pending Attention', () => {
        expect(sessionActivityGroup(session({ hasPendingAttention: true, isRunning: true }))).toBe(
            'working',
        );
    });

    it('never lists a detached Terminal as working, but keeps the result it left pending', () => {
        expect(sessionActivityGroup(session({ isDetached: true, isRunning: true }))).toBe('idle');
        expect(
            sessionActivityGroup(
                session({ hasPendingAttention: true, isDetached: true, isRunning: true }),
            ),
        ).toBe('attention');
    });

    it('treats a usage-limit wait as idle, since it continues on its own', () => {
        expect(
            sessionActivityGroup(
                session({ hasPendingAttention: true, isRunning: true, isUsageWaiting: true }),
            ),
        ).toBe('idle');
    });
});

const row = (id: string, overrides: Partial<SessionActivityRowOrder> = {}) => ({
    id,
    sessionActivityAt: 0,
    ...overrides,
});

const order = (
    group: Parameters<typeof compareSessionActivityGroupRows>[0],
    rows: SessionActivityRowOrder[],
) =>
    rows
        .toSorted((left, right) => compareSessionActivityGroupRows(group, left, right))
        .map((r) => r.id);

describe('compareSessionActivityGroupRows', () => {
    it('ranks questions and failures above results in Needs attention, newest arrival first in each', () => {
        expect(
            order('attention', [
                row('older-result', { sessionActivityAt: 40, lastAttentionKind: 'completed' }),
                row('result', { sessionActivityAt: 50, lastAttentionKind: 'completed' }),
                row('failed', { sessionActivityAt: 10, lastAttentionKind: 'failed' }),
                row('question', { sessionActivityAt: 20, lastAttentionKind: 'waiting' }),
            ]),
        ).toEqual(['question', 'failed', 'result', 'older-result']);
    });

    it('orders working by when the turn started, so a turn ending into a background wait stays in place', () => {
        expect(
            order('working', [
                // Started first, then its turn ended into a background wait, which moved only its activity clock.
                row('watching', { sessionActivityAt: 90, turnStartedAt: 10 }),
                row('busy', { sessionActivityAt: 30, turnStartedAt: 30 }),
                // A row from before the turn clock existed falls back to its activity clock.
                row('legacy', { sessionActivityAt: 20 }),
            ]),
        ).toEqual(['busy', 'legacy', 'watching']);
    });

    it('lifts a Session just marked done to the top of Idle without its work clock', () => {
        expect(
            order('idle', [
                row('recent', { sessionActivityAt: 30 }),
                row('resolved', { sessionActivityAt: 10, attentionResolvedAt: 40 }),
            ]),
        ).toEqual(['resolved', 'recent']);
    });

    it('breaks equal recency by id so the order is stable', () => {
        expect(order('working', [row('b'), row('a')])).toEqual(['a', 'b']);
    });
});
