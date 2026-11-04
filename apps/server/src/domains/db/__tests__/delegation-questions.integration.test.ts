import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { StoredAgentDelegation } from '../models/agent-delegations';
import { CaxriDatabase } from '../repository';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-questions-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const { session } = database.createSession(database.createProject(directory).id, 'shell');
    const delegation = (id: string): StoredAgentDelegation => ({
        receipt: {
            delegationId: id,
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            status: 'running',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        },
        principal: { kind: 'human-cli', id: 'synthetic-owner' },
        input: {
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            prompt: 'Synthetic task',
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
    });
    database.agentDelegations.insert(delegation('delegation-1'));
    database.agentDelegations.insert(delegation('delegation-2'));
    const { questions } = database.agentDelegations;
    const ask = (id: string, delegationId = 'delegation-1', requestId?: string) =>
        questions.insert({
            id,
            delegationId,
            sessionId: session.id,
            childLaunchId: 'launch-1',
            childGeneration: 1,
            requestId,
            text: 'Synthetic question',
            askedAt: 10,
        });
    return { database, questions, ask, delegation };
}

describe('delegation question persistence', () => {
    it('lets the first answer win and reports the loser', async () => {
        const { questions, ask } = await fixture();
        ask('question-1');

        expect(questions.tryAnswer('question-1', 'user', 'Use A', 20)).toBe(true);
        expect(questions.tryAnswer('question-1', 'parent', 'Use B', 21)).toBe(false);
        expect(questions.cancel('question-1', 'task_ended', 22)).toBe(false);
        expect(questions.get('question-1')).toMatchObject({
            state: 'answered',
            answeredBy: 'user',
            answerText: 'Use A',
            closedAt: 20,
        });
    });

    it('lets a cancel beat a later answer', async () => {
        const { questions, ask } = await fixture();
        ask('question-1');

        expect(questions.cancel('question-1', 'taken_over', 20)).toBe(true);
        expect(questions.tryAnswer('question-1', 'parent', 'Use B', 21)).toBe(false);
        expect(questions.get('question-1')).toMatchObject({
            state: 'cancelled',
            cancelReason: 'taken_over',
        });
        expect(questions.get('question-1')?.answerText).toBeUndefined();
    });

    it('escalates only an open question, once', async () => {
        const { questions, ask } = await fixture();
        ask('question-1');

        expect(questions.markEscalated('question-1', 'grace_elapsed', 30)).toBe(true);
        expect(questions.markEscalated('question-1', 'parent_gone', 31)).toBe(false);
        expect(questions.get('question-1')).toMatchObject({
            state: 'open',
            escalatedAt: 30,
            escalationReason: 'grace_elapsed',
        });
        expect(questions.tryAnswer('question-1', 'user', 'Use A', 32)).toBe(true);
        expect(questions.markEscalated('question-1', 'grace_elapsed', 33)).toBe(false);
    });

    it('cancels every open question and reports exactly those that closed', async () => {
        const { questions, ask } = await fixture();
        ask('question-1', 'delegation-1');
        ask('question-2', 'delegation-2');
        questions.tryAnswer('question-2', 'user', 'Done', 15);
        ask('question-3', 'delegation-2');

        const closed = questions.cancelAllOpen('host_reset', 40);

        expect(closed.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'question-1',
            'question-3',
        ]);
        expect(
            closed.map(({ delegationId }) => delegationId).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['delegation-1', 'delegation-2']);
        expect(questions.get('question-2')?.state).toBe('answered');
        expect(questions.cancelAllOpen('host_reset', 41)).toEqual([]);
        expect(questions.get('question-1')).toMatchObject({
            state: 'cancelled',
            cancelReason: 'host_reset',
        });
    });

    it('cancels the open question of the named delegations only', async () => {
        const { questions, ask } = await fixture();
        ask('question-1', 'delegation-1');
        ask('question-2', 'delegation-2');

        const closed = questions.cancelOpenForDelegations(['delegation-1'], 'task_ended', 50);

        expect(closed.map(({ id }) => id)).toEqual(['question-1']);
        expect(questions.openForDelegation('delegation-2')?.id).toBe('question-2');
        expect(questions.cancelOpenForDelegations([], 'task_ended', 51)).toEqual([]);
    });

    it('finds a replayed request in any state and counts every stored question', async () => {
        const { questions, ask } = await fixture();
        ask('question-1', 'delegation-1', 'request-1');
        questions.cancel('question-1', 'child_cancelled', 20);
        ask('question-2', 'delegation-1', 'request-2');

        expect(questions.getByRequestId('delegation-1', 'request-1')?.state).toBe('cancelled');
        expect(questions.getByRequestId('delegation-2', 'request-1')).toBeUndefined();
        expect(questions.countForDelegation('delegation-1')).toBe(2);
        expect(questions.openForDelegations(['delegation-1', 'delegation-2'])).toEqual(
            new Map([['delegation-1', expect.objectContaining({ id: 'question-2' })]]),
        );
    });

    it('removes the questions when pruning deletes their delegation', async () => {
        const { database, questions, ask } = await fixture();
        ask('question-1', 'delegation-1');

        database.database.prepare("DELETE FROM agent_delegations WHERE id = 'delegation-1'").run();

        expect(questions.get('question-1')).toBeUndefined();
        expect(database.database.pragma('foreign_key_check')).toEqual([]);
    });
});
