import { describe, expect, it } from 'vitest';

import type { MobileSession, MobileTerminal } from '../session-model';
import {
    buildMobileSessionSections,
    canMarkSessionDone,
    isMobileTerminalStopped,
} from '../session-model';

const terminal: MobileTerminal = {
    id: 'terminal-1',
    sessionId: 'session-1',
    kind: 'codex',
    provider: 'codex',
    lastProcessState: 'running',
};
const session = (overrides: Partial<MobileSession> = {}): MobileSession => ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Mobile phase one',
    projectTitle: 'Caxri',
    lastVisitedAt: 100,
    sessionActivityAt: 100,
    agentActivityState: 'waiting',
    primaryAgentTerminalId: 'terminal-1',
    attentionGeneration: 3,
    hasUnread: true,
    hasPendingAttention: true,
    primaryTerminal: terminal,
    ...overrides,
});
const quiet = { hasUnread: false, hasPendingAttention: false } as const;

describe('mobile session model', () => {
    it('groups into attention, working, and idle and orders attention by tier then recency', () => {
        const result = buildMobileSessionSections({
            total: 5,
            truncated: false,
            sessions: [
                session({ id: 'result', sessionActivityAt: 500, lastAttentionKind: 'completed' }),
                session({
                    id: 'merged',
                    sessionActivityAt: 400,
                    lastAttentionKind: 'completed',
                    pullRequest: { state: 'merged' } as MobileSession['pullRequest'],
                }),
                session({ id: 'question', sessionActivityAt: 100, lastAttentionKind: 'waiting' }),
                session({
                    id: 'running',
                    sessionActivityAt: 200,
                    agentActivityState: 'running',
                    ...quiet,
                }),
                session({
                    id: 'idle',
                    sessionActivityAt: 300,
                    agentActivityState: 'idle',
                    ...quiet,
                }),
            ],
        });

        expect(result.groups.attention.map((item) => item.id)).toEqual([
            'question',
            'merged',
            'result',
        ]);
        expect(result.groups.working.map((item) => item.id)).toEqual(['running']);
        expect(result.groups.idle.map((item) => item.id)).toEqual(['idle']);
    });

    it('keeps a read Session in attention until it is marked done', () => {
        const result = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [session({ hasUnread: false, agentActivityState: 'completed' })],
        });
        expect(result.groups.attention.map((item) => item.id)).toEqual(['session-1']);
    });

    it('ranks background waits first in working and a just-resolved Session first in idle', () => {
        const result = buildMobileSessionSections({
            total: 4,
            truncated: false,
            sessions: [
                session({
                    id: 'plain',
                    agentActivityState: 'running',
                    sessionActivityAt: 900,
                    ...quiet,
                }),
                session({
                    id: 'background',
                    agentActivityState: 'running',
                    sessionActivityAt: 100,
                    primaryTerminal: { ...terminal, agentOperation: 'background' },
                    ...quiet,
                }),
                session({
                    id: 'old',
                    agentActivityState: 'idle',
                    sessionActivityAt: 300,
                    ...quiet,
                }),
                session({
                    id: 'resolved',
                    agentActivityState: 'idle',
                    sessionActivityAt: 100,
                    attentionResolvedAt: 800,
                    ...quiet,
                }),
            ],
        });
        expect(result.groups.working.map((item) => item.id)).toEqual(['background', 'plain']);
        expect(result.groups.idle.map((item) => item.id)).toEqual(['resolved', 'old']);
    });

    it('files a detached Session with pending attention under attention, not working', () => {
        const result = buildMobileSessionSections({
            total: 2,
            truncated: false,
            sessions: [
                session({
                    id: 'detached',
                    agentActivityState: 'running',
                    primaryTerminal: { ...terminal, lastProcessState: 'detached' },
                }),
                session({ id: 'live', agentActivityState: 'running', ...quiet }),
            ],
        });
        expect(result.groups.attention.map((item) => item.id)).toEqual(['detached']);
        expect(result.groups.working.map((item) => item.id)).toEqual(['live']);
    });

    it('offers Mark as Done only while attention is pending', () => {
        expect(canMarkSessionDone({ hasPendingAttention: true })).toBe(true);
        expect(canMarkSessionDone({ hasPendingAttention: false })).toBe(false);
    });

    it('lists a pinned Session only under Pinned, in pinned order, even when it has news', () => {
        const result = buildMobileSessionSections({
            total: 3,
            truncated: false,
            sessions: [
                session({ id: 'pinned-attention', pinnedAt: 2 }),
                session({
                    id: 'pinned-idle',
                    pinnedAt: 1,
                    hasUnread: false,
                    hasPendingAttention: false,
                    agentActivityState: 'idle',
                }),
                session({ id: 'plain', ...quiet, agentActivityState: 'idle' }),
            ],
        });

        expect(result.groups.pinned.map((item) => item.id)).toEqual([
            'pinned-idle',
            'pinned-attention',
        ]);
        expect(result.groups.attention).toEqual([]);
        expect(result.groups.pinned[1].group).toBe('attention');
        expect(result.groups.idle.map((item) => item.id)).toEqual(['plain']);
        expect(result.sessions.map((item) => item.id)).toEqual([
            'pinned-idle',
            'pinned-attention',
            'plain',
        ]);
    });

    it('recognizes a stopped Agent Terminal', () => {
        const item = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [session()],
        }).groups.attention[0];

        expect(isMobileTerminalStopped(item)).toBe(false);
        expect(
            isMobileTerminalStopped({
                ...item,
                primaryTerminal: { ...terminal, lastProcessState: 'stopped' },
            }),
        ).toBe(true);
    });

    it('builds one thousand Session rows without a pathological model regression', () => {
        const sessions = Array.from({ length: 1_000 }, (_, index) =>
            session({
                id: `session-${index}`,
                sessionActivityAt: index,
                hasUnread: index % 7 === 0,
            }),
        );
        const startedAt = performance.now();

        const result = buildMobileSessionSections({
            total: sessions.length,
            truncated: false,
            sessions,
        });

        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(result.sessions).toHaveLength(1_000);
    });

    it('labels a running Session that only waits on background work ', () => {
        const result = buildMobileSessionSections({
            total: 2,
            truncated: false,
            sessions: [
                session({
                    agentActivityState: 'running',
                    primaryTerminal: { ...terminal, agentOperation: 'background' },
                }),
                session({ id: 'session-2', agentActivityState: 'running' }),
            ],
        });
        const labels = new Map(result.sessions.map((item) => [item.id, item.stateLabel]));
        expect(labels.get('session-1')).toBe('Waiting on background work');
        expect(labels.get('session-2')).toBe('Working');
    });

    it('files a Chat waiting for a usage limit under Idle with the continuation time, even when unread', () => {
        const waiting = session({
            agentActivityState: 'failed',
            hasUnread: true,
            primaryTerminal: { ...terminal, usageLimitWaitAt: Date.UTC(2026, 9, 30, 12, 0) },
        });
        const result = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [waiting],
        });
        expect(result.groups.idle.map((item) => item.id)).toEqual(['session-1']);
        expect(result.groups.attention).toEqual([]);
        expect(result.sessions[0].stateLabel).toMatch(/^Continues automatically at /);
        // The wait ends: the unread failure shows again.
        const ended = buildMobileSessionSections({
            total: 1,
            truncated: false,
            sessions: [{ ...waiting, primaryTerminal: terminal }],
        });
        expect(ended.groups.attention).toHaveLength(1);
    });
});
