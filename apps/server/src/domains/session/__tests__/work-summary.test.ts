import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { SESSION_WORK_SUMMARY_ATTENTION_MAX } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { summarizeSessionWork } from '../work-summary';

const projects: Array<Pick<ProjectRecord, 'id' | 'ownerProjectId' | 'title'>> = [
    { id: 'p1', title: 'App' },
    { id: 'wt', ownerProjectId: 'p1', title: 'App worktree' },
];

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id,
        projectId: 'p1',
        title: `Session ${id}`,
        hasPendingAttention: false,
        sessionActivityAt: 1,
        ...overrides,
    } as SessionRecord;
}

function terminal(id: string, overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return { id, kind: 'agent', sessionId: id, ...overrides } as TerminalRecord;
}

describe('summarizeSessionWork', () => {
    it('counts running Agents everywhere, worktree Projects included, but not archived Sessions', () => {
        const summary = summarizeSessionWork({
            projects,
            sessions: [
                session('a', { agentActivityState: 'running' }),
                session('b', { agentActivityState: 'running', projectId: 'wt' }),
                session('c', { agentActivityState: 'running', archivedAt: 5 }),
                session('d', { primaryAgentTerminalId: 'd' }),
            ],
            terminals: [terminal('d', { agentOperation: 'compacting' })],
        });
        expect(summary).toMatchObject({ working: 3, usageWaiting: 0, attentionCount: 0 });
    });

    it('counts a Chat waiting for its usage limit as waiting, not as needing the user', () => {
        const summary = summarizeSessionWork({
            projects,
            sessions: [
                session('a', {
                    primaryAgentTerminalId: 'a',
                    hasPendingAttention: true,
                    lastAttentionKind: 'failed',
                }),
            ],
            terminals: [terminal('a', { usageLimitWaitAt: 10 })],
        });
        expect(summary).toMatchObject({ working: 0, usageWaiting: 1, attentionCount: 0 });
    });

    it('lists blocked Sessions before results and leaves out worktree Projects and creator work', () => {
        const summary = summarizeSessionWork({
            projects,
            sessions: [
                session('result', {
                    hasPendingAttention: true,
                    lastAttentionKind: 'completed',
                    sessionActivityAt: 30,
                }),
                session('waiting', {
                    hasPendingAttention: true,
                    lastAttentionKind: 'waiting',
                    sessionActivityAt: 10,
                }),
                session('hidden-project', {
                    hasPendingAttention: true,
                    lastAttentionKind: 'completed',
                    projectId: 'wt',
                }),
                session('consult', {
                    hasPendingAttention: true,
                    lastAttentionKind: 'completed',
                    createdByRelation: 'consult',
                    createdBySessionId: 'result',
                }),
            ],
            terminals: [],
        });
        expect(summary.attentionCount).toBe(2);
        expect(summary.attention).toEqual([
            {
                sessionId: 'waiting',
                title: 'Session waiting',
                projectTitle: 'App',
                kind: 'waiting',
            },
            { sessionId: 'result', title: 'Session result', projectTitle: 'App', kind: 'result' },
        ]);
    });

    it('caps the list but reports the full count', () => {
        const sessions = Array.from(
            { length: SESSION_WORK_SUMMARY_ATTENTION_MAX + 3 },
            (_, index) =>
                session(`s${index}`, { hasPendingAttention: true, lastAttentionKind: 'completed' }),
        );
        const summary = summarizeSessionWork({ projects, sessions, terminals: [] });
        expect(summary.attentionCount).toBe(SESSION_WORK_SUMMARY_ATTENTION_MAX + 3);
        expect(summary.attention).toHaveLength(SESSION_WORK_SUMMARY_ATTENTION_MAX);
    });
});
