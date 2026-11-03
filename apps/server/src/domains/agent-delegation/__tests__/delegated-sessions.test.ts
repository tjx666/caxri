import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DELEGATION_SUMMARY_INSTRUCTION } from '../task-body';
import { delegatedFixture, digest } from './delegated-sessions.fixture';

describe('the task file of a delegated Session', () => {
    const owner = { principal: { kind: 'human-cli' as const, id: 'owner', generation: 1 } };
    /**
     * The body a task's Agent reads: `task.md` for the first task of a conversation, `<root>/<id>.md` for a follow-up
     * or a resume that continues it.
     */
    const taskFile = (f: Awaited<ReturnType<typeof delegatedFixture>>, id: string) => {
        const { rootDelegationId } = f.database.agentDelegations.get(id)!;
        const isFirst = !rootDelegationId || rootDelegationId === id;
        return readFile(
            join(
                f.directory,
                'delegations',
                isFirst ? id : rootDelegationId,
                isFirst ? 'task.md' : `${id}.md`,
            ),
            'utf8',
        );
    };

    it.each([{}, { consult: true as const }])(
        'ends the first task of a new Session another Session created with the Summary instruction (%o)',
        async (flags) => {
            const f = await delegatedFixture();
            const task = await f.delegate(flags);

            expect(await taskFile(f, task.id)).toBe(
                `Synthetic private task\n\n${DELEGATION_SUMMARY_INSTRUCTION}`,
            );
        },
    );

    it.each(['followUpOf', 'resumeFrom'] as const)(
        'ends a task that continues the conversation with --%s with it too',
        async (flag) => {
            const f = await delegatedFixture();
            const first = await f.delegate();
            await f.finish(first, 'Summary: First finding.');
            f.database.rebindAgentSession(
                first.terminalId,
                'claude',
                f.database.agentDelegations.get(first.id)!.providerSessionId!,
            );
            const id = randomUUID();

            const receipt = await f.service.create(id, f.authority, {
                projectId: f.project.id,
                sessionId: first.receipt.sessionId,
                provider: 'claude',
                prompt: 'Synthetic follow-up task',
                [flag]: first.id,
            });

            expect(receipt.status).not.toBe('failed');
            expect(f.database.agentDelegations.get(id)?.input[flag]).toBe(first.id);
            expect(await taskFile(f, id)).toBe(
                `Synthetic follow-up task\n\n${DELEGATION_SUMMARY_INSTRUCTION}`,
            );
        },
    );

    it('leaves it out of a hand-off, whose result is never stored', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate({ handoff: true });

        expect(await taskFile(f, task.id)).toBe('Synthetic private task');
    });

    it('leaves it out of an ordinary Session and of a new Session the owner created', async () => {
        const f = await delegatedFixture();
        const ordinary = f.database.createSession(f.project.id, null).session;
        const ordinaryId = randomUUID();
        await f.service.create(ordinaryId, owner, {
            projectId: f.project.id,
            sessionId: ordinary.id,
            provider: 'claude',
            prompt: 'Synthetic ordinary task',
        });
        const ownerNewId = randomUUID();
        await f.service.create(ownerNewId, owner, f.request);

        expect(await taskFile(f, ordinaryId)).toBe('Synthetic ordinary task');
        expect(await taskFile(f, ownerNewId)).toBe('Synthetic private task');
    });

    it('leaves the pointer the Chat receives, and its digest, as they were', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();

        const pointer = f.dispatchStart.mock.lastCall?.[3]?.initialPrompt ?? '';
        expect(pointer).not.toContain('Summary');
        expect(digest(pointer)).toBe(f.database.agentDelegations.get(task.id)?.promptDigest);
        f.start(task);
        expect(f.service.status(task.id, f.authority).status).toBe('running');
    });
});

describe('the result of a task in a delegated Session', () => {
    it('stores the closing Summary line the Agent wrote', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();

        await f.finish(task, 'I traced the backoff.\nSummary: The retry backoff is correct.');

        expect(f.database.createdSessions.results([task.receipt.sessionId])).toEqual(
            new Map([
                [
                    task.receipt.sessionId,
                    {
                        sessionId: task.receipt.sessionId,
                        delegationId: task.id,
                        summary: 'The retry backoff is correct.',
                        source: 'authored',
                        completedAt: f.state.clock,
                    },
                ],
            ]),
        );
    });

    it('falls back to the first paragraph of an answer with no Summary line', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate({ consult: true });

        await f.finish(task, 'The cache key ignores the locale.\n\nMore detail follows.');

        expect(
            f.database.createdSessions
                .results([task.receipt.sessionId])
                .get(task.receipt.sessionId),
        ).toMatchObject({ summary: 'The cache key ignores the locale.', source: 'excerpt' });
    });

    it('is replaced by the result of a later task in the same Session', async () => {
        const f = await delegatedFixture();
        const first = await f.delegate();
        await f.finish(first, 'Summary: First finding.');
        f.state.clock += 1000;
        const secondId = randomUUID();
        const second = await f.service.create(secondId, f.authority, {
            projectId: f.project.id,
            sessionId: first.receipt.sessionId,
            provider: 'claude',
            prompt: 'Synthetic second task',
        });

        await f.finish(
            { id: secondId, terminalId: second.terminalId! },
            'Summary: Second finding.',
        );

        expect(
            f.database.createdSessions
                .results([first.receipt.sessionId])
                .get(first.receipt.sessionId),
        ).toMatchObject({ delegationId: secondId, summary: 'Second finding.' });
    });

    it('is not stored for a hand-off, which the user takes over', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate({ handoff: true });

        await f.finish(task, 'Summary: Handed off.');

        expect(f.database.createdSessions.results([task.receipt.sessionId]).size).toBe(0);
    });

    it('is not stored for a task that failed', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        const signal = f.start(task);

        f.service.observe({ ...signal, phase: 'turnFailed', agentFailure: 'provider_failed' });

        expect(f.service.status(task.id, f.authority).status).toBe('failed');
        expect(f.database.createdSessions.results([task.receipt.sessionId]).size).toBe(0);
    });

    it('is written once, not again by a later save of the completed task', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Done once.');
        const saveResult = vi.spyOn(f.database.createdSessions, 'saveResult');

        f.service.interruptTerminal(task.terminalId, true);
        await f.service.result(task.id, f.authority);

        expect(saveResult).not.toHaveBeenCalled();
    });
});

describe('settledAt and failureResetsAt of a delegated task', () => {
    it('stamps settledAt when the task completes and keeps it through later saves', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        expect(f.service.status(task.id, f.authority)).not.toHaveProperty('settledAt');

        await f.finish(task, 'Summary: Done.');
        const settledAt = f.state.clock;
        expect(f.service.status(task.id, f.authority).settledAt).toBe(settledAt);

        f.state.clock += 5000;
        f.service.interruptTerminal(task.terminalId, true);
        expect(f.service.status(task.id, f.authority)).toMatchObject({
            settledAt,
            updatedAt: f.state.clock,
        });
    });

    it('records the reset time of the usage limit that failed the task', async () => {
        const limitResetsAt = vi.fn(() => 61_000);
        const f = await delegatedFixture({ limitResetsAt });
        const task = await f.delegate();
        const signal = f.start(task);

        f.service.observe({ ...signal, phase: 'turnFailed', agentFailure: 'billing_error' });

        expect(f.service.status(task.id, f.authority)).toMatchObject({
            status: 'failed',
            failure: 'quota_exhausted',
            failureResetsAt: 61_000,
        });
        expect(limitResetsAt).toHaveBeenCalledWith({
            provider: 'claude',
            terminalId: task.terminalId,
            turnId: signal.agentTurnId,
        });
    });

    it('leaves failureResetsAt out when no source knows the reset time', async () => {
        const f = await delegatedFixture({ limitResetsAt: () => {} });
        const task = await f.delegate();
        const signal = f.start(task);

        f.service.observe({ ...signal, phase: 'turnFailed', agentFailure: 'rate_limit' });

        const receipt = f.service.status(task.id, f.authority);
        expect(receipt).toMatchObject({ status: 'failed', failure: 'rate_limited' });
        expect(receipt).not.toHaveProperty('failureResetsAt');
    });
});
