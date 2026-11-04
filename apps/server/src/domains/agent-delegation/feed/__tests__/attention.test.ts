import { randomUUID } from 'node:crypto';

import { parseServerOperationResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createBackgroundSession } from '../../../session';
import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';
import { createDelegationHandlers } from '../../handlers';
import { MAX_ROLLUP_DEPTH } from '../../tree';

type Fixture = Awaited<ReturnType<typeof delegatedFixture>>;
type Task = Awaited<ReturnType<Fixture['delegate']>>;

/**
 * `agent.delegation.attention` through the handler and the method's result schema, as a Client receives it.
 */
async function attention(f: Fixture, sessionId: string) {
    return parseServerOperationResult(
        'agent.delegation.attention',
        await createDelegationHandlers(f.service, f.database)['agent.delegation.attention']({
            sessionId,
        }),
    );
}

/**
 * Delegates a task from inside an earlier task's Session, so it sits one level deeper in the tree.
 */
async function delegateFrom(
    f: Fixture,
    parent: Task,
    flags: { consult?: true; handoff?: true } = {},
): Promise<Task> {
    f.state.clock += 1000;
    const id = randomUUID();
    const receipt = await f.service.create(
        id,
        { ...f.authority, callerTerminalId: parent.terminalId },
        { ...f.request, ...flags },
    );
    return { id, receipt, terminalId: receipt.terminalId! };
}

function settle(
    f: Fixture,
    task: Task,
    receipt: Record<string, unknown>,
    stored: Record<string, unknown> = {},
) {
    const record = f.database.agentDelegations.get(task.id)!;
    f.database.agentDelegations.save({
        ...record,
        ...stored,
        receipt: { ...record.receipt, ...receipt },
    });
}

const failed = { status: 'failed', failure: 'quota_exhausted', settledAt: 5000 } as const;
const blocked = { status: 'blocked', failure: 'permission_required' } as const;

describe('agent.delegation.attention', () => {
    it('lists a grandchild that needs the user under its direct child and never the direct child itself', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const grandchild = await delegateFrom(f, child);
        settle(f, child, blocked);
        settle(f, grandchild, blocked);

        const { items, isPartial } = await attention(f, f.callerSessionId);

        expect(isPartial).toBe(false);
        expect(items).toEqual([
            expect.objectContaining({
                sessionId: grandchild.receipt.sessionId,
                createdBySessionId: child.receipt.sessionId,
                branchSessionId: child.receipt.sessionId,
                relation: 'delegated',
                status: 'blocked',
            }),
        ]);
    });

    it('carries ids and closed values only: no step, result, or text', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const grandchild = await delegateFrom(f, child);
        settle(f, grandchild, failed);
        f.state.step = 'Reading Secret step text';

        const { items } = await attention(f, f.callerSessionId);

        expect(items).toHaveLength(1);
        expect(items[0]).not.toHaveProperty('step');
        expect(items[0]).not.toHaveProperty('result');
        expect(JSON.stringify(items)).not.toContain('Synthetic private task');
        expect(JSON.stringify(items)).not.toContain('Secret step text');
    });

    it('lists an escalated question and leaves out one the delegating Agent still holds', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const escalated = await delegateFrom(f, child);
        const held = await delegateFrom(f, child);
        for (const [task, questionId] of [
            [escalated, 'question-escalated'],
            [held, 'question-held'],
        ] as const)
            f.database.agentDelegations.questions.insert({
                id: questionId,
                delegationId: task.id,
                sessionId: task.receipt.sessionId,
                childLaunchId: 'launch',
                childGeneration: 1,
                text: 'Which option?',
                askedAt: 2000,
            });
        f.database.agentDelegations.questions.markEscalated(
            'question-escalated',
            'grace_elapsed',
            3000,
        );

        const { items } = await attention(f, f.callerSessionId);

        expect(items.map((item) => item.sessionId)).toEqual([escalated.receipt.sessionId]);
        expect(items[0]).toMatchObject({
            waitingOn: 'user',
            question: { questionId: 'question-escalated', escalated: true },
        });
    });

    it('folds a retried failure into its successor before listing, so a successful retry leaves nothing', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const original = await delegateFrom(f, child);
        const retry = await delegateFrom(f, child);
        settle(f, original, { ...failed, retriedAs: retry.id });
        settle(f, retry, { status: 'completed', retryOf: original.id, settledAt: 6000 });

        expect((await attention(f, f.callerSessionId)).items).toEqual([]);

        // The retry failed too: only the newest attempt is the user's to-do.
        settle(f, retry, { ...failed, retryOf: original.id });
        expect(
            (await attention(f, f.callerSessionId)).items.map((item) => item.delegationId),
        ).toEqual([retry.id]);
    });

    it('does not list a failure whose retry is scheduled or whose successor was pruned', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const scheduled = await delegateFrom(f, child);
        const pruned = await delegateFrom(f, child);
        settle(
            f,
            scheduled,
            { ...failed, retriedAs: 'reserved', retryScheduledFor: 99_000 },
            { retryMode: 'resume' },
        );
        settle(f, pruned, { ...failed, retriedAs: 'pruned-successor' });

        expect((await attention(f, f.callerSessionId)).items).toEqual([]);
    });

    it('does not list non-failure endings, a running task, or a finished one', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const stopped = await delegateFrom(f, child);
        const intervened = await delegateFrom(f, child);
        const completed = await delegateFrom(f, child);
        await delegateFrom(f, child);
        settle(f, stopped, { status: 'failed', failure: 'caller_stopped' });
        settle(f, intervened, { status: 'failed', failure: 'human_input' });
        settle(f, completed, { status: 'completed' });

        expect((await attention(f, f.callerSessionId)).items).toEqual([]);
    });

    it('ranks what blocks the user before failures, newest first, and drops archived and deleted Sessions', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const olderFailure = await delegateFrom(f, child);
        const prompt = await delegateFrom(f, child);
        const newerFailure = await delegateFrom(f, child);
        const archived = await delegateFrom(f, child);
        const deleted = await delegateFrom(f, child);
        settle(f, olderFailure, failed);
        settle(f, prompt, { status: 'blocked', failure: 'startup_waiting' });
        settle(f, newerFailure, failed);
        settle(f, archived, failed);
        settle(f, deleted, failed);
        f.database.archiveSession(archived.receipt.sessionId);
        f.database.deleteSession(deleted.receipt.sessionId);

        const { items } = await attention(f, f.callerSessionId);

        expect(items.map((item) => item.sessionId)).toEqual([
            prompt.receipt.sessionId,
            newerFailure.receipt.sessionId,
            olderFailure.receipt.sessionId,
        ]);
    });

    it('does not roll up a hand-off Session or what it delegated', async () => {
        const f = await delegatedFixture();
        const handoff = await f.delegate({ handoff: true });
        const nested = await delegateFrom(f, handoff);
        settle(f, nested, failed);

        expect((await attention(f, f.callerSessionId)).items).toEqual([]);
    });

    it('lists a consult Session that needs the user', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const consult = await delegateFrom(f, child, { consult: true });
        settle(f, consult, blocked);

        const { items } = await attention(f, f.callerSessionId);

        expect(items).toEqual([
            expect.objectContaining({ sessionId: consult.receipt.sessionId, relation: 'consult' }),
        ]);
    });

    it('visits a Session reachable by two paths once, and ignores a cycle back to the root', async () => {
        const f = await delegatedFixture();
        const left = await f.delegate();
        const right = await f.delegate();
        const shared = await delegateFrom(f, left);
        settle(f, shared, failed);
        f.database.agentDelegations.history.recordEdge({
            sessionId: shared.receipt.sessionId,
            parentSessionId: right.receipt.sessionId,
            relation: 'delegated',
            createdAt: 1,
        });
        f.database.agentDelegations.history.recordEdge({
            sessionId: f.callerSessionId,
            parentSessionId: shared.receipt.sessionId,
            relation: 'delegated',
            createdAt: 1,
        });

        const { items } = await attention(f, f.callerSessionId);

        expect(items.map((item) => item.sessionId)).toEqual([shared.receipt.sessionId]);
    });

    it('caps the list at 64 items and says it is partial, keeping the most urgent', async () => {
        const f = await delegatedFixture();
        const child = await f.delegate();
        const prompt = await delegateFrom(f, child);
        settle(f, prompt, blocked);
        const promptRecord = f.database.agentDelegations.get(prompt.id)!;
        for (let index = 0; index < 70; index += 1) {
            const session = createBackgroundSession(
                f.database,
                f.project.id,
                `Failed ${index}`,
                child.receipt.sessionId,
                'delegated',
            );
            f.database.agentDelegations.insert({
                ...promptRecord,
                receipt: {
                    ...promptRecord.receipt,
                    ...failed,
                    delegationId: `failed-${index}`,
                    sessionId: session,
                    createdAt: 100 + index,
                },
            });
        }

        const { items, isPartial } = await attention(f, f.callerSessionId);

        expect(items).toHaveLength(64);
        expect(isPartial).toBe(true);
        expect(items[0].sessionId).toBe(prompt.receipt.sessionId);
    });

    it('is partial when the walk stops at the depth bound, even with nothing to list', async () => {
        const f = await delegatedFixture();
        let tip = f.callerSessionId;
        for (let depth = 0; depth < MAX_ROLLUP_DEPTH + 2; depth += 1)
            tip = createBackgroundSession(
                f.database,
                f.project.id,
                `Level ${depth}`,
                tip,
                'delegated',
            );

        expect(await attention(f, f.callerSessionId)).toEqual({ items: [], isPartial: true });
    });
});
