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
    it('ranks questions and failures, then merged pull requests, then other results in Needs attention', () => {
        expect(
            order('attention', [
                row('result', { sessionActivityAt: 50, lastAttentionKind: 'completed' }),
                row('merged', {
                    sessionActivityAt: 40,
                    lastAttentionKind: 'completed',
                    isPullRequestMerged: true,
                }),
                row('failed', { sessionActivityAt: 10, lastAttentionKind: 'failed' }),
                row('question', { sessionActivityAt: 20, lastAttentionKind: 'waiting' }),
            ]),
        ).toEqual(['question', 'failed', 'merged', 'result']);
    });

    it('puts Sessions waiting on background work first in working', () => {
        expect(
            order('working', [
                row('busy', { sessionActivityAt: 30 }),
                row('watching', { sessionActivityAt: 10, isBackgroundWait: true }),
            ]),
        ).toEqual(['watching', 'busy']);
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
