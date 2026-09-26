import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentAttentionRequests } from '../attention-requests';

afterEach(() => vi.useRealTimers());

const permission = {
    sessionId: 'session-one',
    terminalId: 'terminal-one',
    launchId: 'launch-one',
    kind: 'permission' as const,
    toolName: 'Bash',
    summary: 'git status',
    questions: [],
};

describe('AgentAttentionRequests', () => {
    it('applies one answer only to the matching pending request', async () => {
        const store = new AgentAttentionRequests();
        const pending = store.offer(permission);
        const request = store.list('session-one')[0];
        expect(store.list('another-session')).toEqual([]);
        expect(() => store.answer('another-session', request.id, { decision: 'allow' })).toThrow(
            /not found/u,
        );
        expect(store.answer('session-one', request.id, { decision: 'allow' })).toEqual({
            status: 'answered',
        });
        expect(await pending).toEqual({ requestId: request.id, answer: { decision: 'allow' } });
        expect(() => store.answer('session-one', request.id, { decision: 'deny' })).toThrow(
            /no longer pending/u,
        );
        store.markApplied(request.id);
        expect(store.list('session-one')[0].status).toBe('applied');
    });

    it('supersedes a disconnected hook and expires an unanswered request', async () => {
        vi.useFakeTimers();
        const store = new AgentAttentionRequests();
        const controller = new AbortController();
        const disconnected = store.offer({ ...permission, signal: controller.signal });
        controller.abort();
        expect((await disconnected).answer).toBeNull();
        expect(store.list('session-one')[0].status).toBe('superseded');
        const expired = store.offer(permission);
        await vi.advanceTimersByTimeAsync(120_001);
        expect((await expired).answer).toBeNull();
        expect(store.list('session-one').at(-1)?.status).toBe('expired');
    });

    it('requires answers for every step of a grouped question', async () => {
        const store = new AgentAttentionRequests();
        const pending = store.offer({
            ...permission,
            kind: 'question',
            toolName: 'AskUserQuestion',
            questions: [
                {
                    question: 'Which?',
                    header: 'Choice',
                    multiSelect: false,
                    options: [{ label: 'A' }],
                },
                { question: 'Why?', header: 'Reason', multiSelect: false, options: [] },
            ],
        });
        const id = store.list('session-one')[0].id;
        expect(() => store.answer('session-one', id, { answers: { 'Which?': 'A' } })).toThrow();
        store.answer('session-one', id, { answers: { 'Which?': 'A', 'Why?': 'Because' } });
        expect((await pending).answer).toEqual({ answers: { 'Which?': 'A', 'Why?': 'Because' } });
    });
});
