import { randomUUID } from 'node:crypto';

import type { AgentDelegationProgress } from '@caxri/protocol';
import { agentDelegationSettingsSchema, serverEventSchema } from '@caxri/protocol';
import { omit } from 'es-toolkit';
import { describe, expect, it, vi } from 'vitest';

import { createBackgroundSession } from '../../../session';
import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';

describe('agent.delegation.sessions', () => {
    it('lists the Sessions another Session created with their newest task and stored result', async () => {
        const f = await delegatedFixture();
        const delegated = await f.delegate();
        await f.finish(delegated, 'Summary: Reviewed the design.');
        const completedAt = f.state.clock;
        const consulted = await f.delegate({ consult: true });
        f.start(consulted);

        const sessions = await f.sessions([f.callerSessionId]);

        expect(sessions).toHaveLength(2);
        expect(sessions).toContainEqual({
            sessionId: consulted.receipt.sessionId,
            createdBySessionId: f.callerSessionId,
            relation: 'consult',
            delegationId: consulted.id,
            provider: 'claude',
            selection: { provider: 'claude' },
            status: 'running',
            createdAt: expect.any(Number) as number,
        });
        expect(sessions).toContainEqual(
            expect.objectContaining({
                sessionId: delegated.receipt.sessionId,
                relation: 'delegated',
                delegationId: delegated.id,
                status: 'completed',
                settledAt: expect.any(Number) as number,
                result: {
                    summary: 'Reviewed the design.',
                    source: 'authored',
                    delegationId: delegated.id,
                    completedAt,
                },
            }),
        );
    });

    it('keeps the frozen preset selection on the entry after the preset leaves Settings', async () => {
        let settings = agentDelegationSettingsSchema.parse({
            presets: [
                {
                    name: 'review',
                    provider: 'codex',
                    model: 'gpt-5.5',
                    effort: 'high',
                    useWhen: 'Review',
                },
            ],
        });
        const f = await delegatedFixture({ delegationSettings: () => settings });
        const id = randomUUID();
        const request = omit(f.request, ['provider']);
        const receipt = await f.service.create(id, f.authority, { ...request, preset: 'review' });
        settings = agentDelegationSettingsSchema.parse({});

        expect(await f.sessions([f.callerSessionId])).toContainEqual(
            expect.objectContaining({
                sessionId: receipt.sessionId,
                selection: {
                    provider: 'codex',
                    model: 'gpt-5.5',
                    effort: 'high',
                    preset: 'review',
                },
            }),
        );
    });

    it('names the task a stored result belongs to, so an older result is not read as the newest task', async () => {
        const f = await delegatedFixture();
        const first = await f.delegate();
        await f.finish(first, 'Summary: First finding.');
        const completedAt = f.state.clock;
        f.state.clock += 1000;
        const secondId = randomUUID();
        const second = await f.service.create(secondId, f.authority, {
            projectId: f.project.id,
            sessionId: first.receipt.sessionId,
            provider: 'claude',
            prompt: 'Synthetic second task',
        });
        f.start({ id: secondId, terminalId: second.terminalId! });

        const [session] = await f.sessions([f.callerSessionId]);

        expect(session).toMatchObject({ delegationId: secondId, status: 'running' });
        expect(session.result).toEqual({
            summary: 'First finding.',
            source: 'authored',
            delegationId: first.id,
            completedAt,
        });
        expect(session.result?.delegationId).not.toBe(session.delegationId);
    });

    it('drops the older result when the newest task completes with nothing to summarize', async () => {
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

        await f.finish({ id: secondId, terminalId: second.terminalId! }, '# Only a heading');

        const [session] = await f.sessions([f.callerSessionId]);
        expect(session).toMatchObject({ delegationId: secondId, status: 'completed' });
        expect(session).not.toHaveProperty('result');
    });

    it('shows the step of an active Chat Session only while its task is active', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        f.start(task);
        f.state.step = 'Running pnpm lint';

        expect((await f.sessions([f.callerSessionId]))[0].step).toBe('Running pnpm lint');

        await f.finish(task, 'Summary: Done.');
        expect((await f.sessions([f.callerSessionId]))[0]).not.toHaveProperty('step');
    });

    describe('a follow-up refused because another task holds the Session', () => {
        /**
         * Asks for a follow-up of `parent` in its Session; the Server records every request, refused or not.
         */
        const followUp = async (
            f: Awaited<ReturnType<typeof delegatedFixture>>,
            parent: { id: string; receipt: { sessionId: string } },
        ) => {
            f.state.clock += 1000;
            const id = randomUUID();
            const receipt = await f.service.create(id, f.authority, {
                projectId: f.project.id,
                sessionId: parent.receipt.sessionId,
                provider: 'claude',
                prompt: 'Synthetic follow-up task',
                followUpOf: parent.id,
            });
            return { id, receipt };
        };

        it('keeps reporting the running task and its step, not the refusal', async () => {
            const f = await delegatedFixture();
            const task = await f.delegate();
            f.start(task);
            f.state.step = 'Running pnpm lint';

            const refused = await followUp(f, task);

            expect(refused.receipt).toMatchObject({ status: 'failed', failure: 'target_busy' });
            const [session] = await f.sessions([f.callerSessionId]);
            expect(session).toMatchObject({
                delegationId: task.id,
                status: 'running',
                step: 'Running pnpm lint',
            });
            expect(session).not.toHaveProperty('failure');
        });

        it('reports the follow-up that took the Session when a second one is refused as chained', async () => {
            const f = await delegatedFixture();
            const first = await f.delegate();
            await f.finish(first, 'Summary: First finding.');
            f.database.rebindAgentSession(
                first.terminalId,
                'claude',
                f.database.agentDelegations.get(first.id)!.providerSessionId!,
            );
            const admitted = await followUp(f, first);
            expect(admitted.receipt.status).not.toBe('failed');

            const refused = await followUp(f, first);

            expect(refused.receipt).toMatchObject({ status: 'failed', failure: 'target_busy' });
            const [session] = await f.sessions([f.callerSessionId]);
            expect(session).toMatchObject({ delegationId: admitted.id });
            expect(session).not.toHaveProperty('failure');
        });

        it('reports the settled task that held the Session, not a later refusal', async () => {
            const f = await delegatedFixture();
            const first = await f.delegate();
            await f.finish(first, 'Summary: First finding.');
            f.database.rebindAgentSession(
                first.terminalId,
                'claude',
                f.database.agentDelegations.get(first.id)!.providerSessionId!,
            );
            const admitted = await followUp(f, first);
            f.service.stop(admitted.id, f.authority);
            await followUp(f, first);

            const [session] = await f.sessions([f.callerSessionId]);

            expect(session).toMatchObject({
                delegationId: admitted.id,
                status: 'interrupted',
                failure: 'caller_stopped',
            });
        });

        it('still reports a refusal when it is the only task the Session has left', async () => {
            const f = await delegatedFixture();
            const task = await f.delegate();
            f.start(task);
            const refused = await followUp(f, task);
            f.database.database.prepare('DELETE FROM agent_delegations WHERE id = ?').run(task.id);

            const [session] = await f.sessions([f.callerSessionId]);

            expect(session).toMatchObject({
                delegationId: refused.id,
                status: 'failed',
                failure: 'target_busy',
            });
        });
    });

    it('reports the settled task, not a follow-up refused because the Session was not ready', async () => {
        let isIdle = true;
        const f = await delegatedFixture({ isIdle: () => isIdle });
        const first = await f.delegate();
        await f.finish(first, 'Summary: First finding.');
        f.database.rebindAgentSession(
            first.terminalId,
            'claude',
            f.database.agentDelegations.get(first.id)!.providerSessionId!,
        );
        isIdle = false;
        f.state.clock += 1000;
        const refusedId = randomUUID();
        const refused = await f.service.create(refusedId, f.authority, {
            projectId: f.project.id,
            sessionId: first.receipt.sessionId,
            provider: 'claude',
            prompt: 'Synthetic follow-up task',
            followUpOf: first.id,
        });

        expect(refused).toMatchObject({ status: 'failed', failure: 'target_not_ready' });
        const [session] = await f.sessions([f.callerSessionId]);
        expect(session).toMatchObject({ delegationId: first.id, status: 'completed' });
        expect(session).not.toHaveProperty('failure');
    });

    it('dates the takeover of a Session, including after its task completed', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Done.');
        expect((await f.sessions([f.callerSessionId]))[0]).not.toHaveProperty('takenOverAt');

        f.state.clock += 5000;
        f.service.interruptTerminal(task.terminalId, true);
        const takenOverAt = f.state.clock;
        f.state.clock += 5000;
        f.service.interruptTerminal(task.terminalId, true);

        const [session] = await f.sessions([f.callerSessionId]);
        expect(session).toMatchObject({ status: 'completed', takenOverAt });
        expect(f.database.agentDelegations.get(task.id)).toMatchObject({
            hasHumanIntervention: true,
            humanInterventionAt: takenOverAt,
        });
    });

    it('dates the takeover of a task delegated into a Terminal the user already typed in', async () => {
        const f = await delegatedFixture();
        const first = await f.delegate();
        f.start(first);
        f.state.clock += 1000;
        f.service.interruptTerminal(first.terminalId, true);

        // A later task lands in the same Terminal (`--session`), after the first input already marked the first one.
        const stored = f.database.agentDelegations.get(first.id)!;
        const secondId = randomUUID();
        const unmarked = structuredClone(stored);
        delete unmarked.hasHumanIntervention;
        delete unmarked.humanInterventionAt;
        f.database.agentDelegations.insert({
            ...unmarked,
            receipt: { ...stored.receipt, delegationId: secondId, status: 'running' },
        });
        expect(f.database.agentDelegations.get(secondId)).not.toHaveProperty('humanInterventionAt');

        f.state.clock += 1000;
        const takenOverAt = f.state.clock;
        f.service.interruptTerminal(first.terminalId, true);

        expect(f.database.agentDelegations.get(secondId)).toMatchObject({
            hasHumanIntervention: true,
            humanInterventionAt: takenOverAt,
        });
    });

    it('ignores Sessions without a relation and lists nothing under other Sessions', async () => {
        const f = await delegatedFixture();
        const related = await f.delegate();
        createBackgroundSession(f.database, f.project.id, 'Plain', f.callerSessionId);
        f.database.createSession(f.project.id, null);

        const sessions = await f.sessions([f.callerSessionId]);

        expect(sessions.map((session) => session.sessionId)).toEqual([related.receipt.sessionId]);
        expect(await f.sessions([related.receipt.sessionId])).toEqual([]);
    });

    it('reports a Session whose task record is gone with its stored result only', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Outlived its task.');
        f.database.database.prepare('DELETE FROM agent_delegations').run();

        expect(await f.sessions([f.callerSessionId])).toEqual([
            {
                sessionId: task.receipt.sessionId,
                createdBySessionId: f.callerSessionId,
                relation: 'delegated',
                result: {
                    summary: 'Outlived its task.',
                    source: 'authored',
                    delegationId: task.id,
                    completedAt: f.state.clock,
                },
            },
        ]);
    });

    it('carries the reset time of a usage-limit failure', async () => {
        const f = await delegatedFixture({ limitResetsAt: () => 61_000 });
        const task = await f.delegate();
        const signal = f.start(task);
        f.service.observe({ ...signal, phase: 'turnFailed', agentFailure: 'billing_error' });

        expect((await f.sessions([f.callerSessionId]))[0]).toMatchObject({
            status: 'failed',
            failure: 'quota_exhausted',
            failureResetsAt: 61_000,
        });
    });

    it('does not claim an answer the delegating Agent has not read', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Still unread.');

        const sessions = await f.sessions([f.callerSessionId]);

        expect(sessions[0].result?.summary).toBe('Still unread.');
        const stored = f.database.agentDelegations.get(task.id)!;
        expect(stored.collectedAt).toBeUndefined();
        expect(stored.answer?.text).toContain('Still unread.');
    });
});

describe('agent.delegation.progress', () => {
    it('publishes the step of an active Chat Session when it changes', async () => {
        const onProgress = vi.fn<(progress: AgentDelegationProgress) => void>();
        const f = await delegatedFixture({ onProgress });
        const task = await f.delegate();
        f.start(task);

        f.state.step = 'Reading a.ts';
        f.service.observeChatProgress(task.terminalId);
        f.service.observeChatProgress(task.terminalId);

        expect(onProgress.mock.calls).toEqual([
            [{ sessionId: task.receipt.sessionId, delegationId: task.id, step: 'Reading a.ts' }],
        ]);
        /**
         * The payload as a Client receives it, through the event's own schema.
         */
        const payload = onProgress.mock.calls[0][0];
        expect(serverEventSchema.parse({ event: 'agent.delegation.progress', payload })).toEqual({
            event: 'agent.delegation.progress',
            payload,
        });
    });

    it('publishes nothing for a Terminal with no active task or once the task settled', async () => {
        const onProgress = vi.fn<(progress: AgentDelegationProgress) => void>();
        const f = await delegatedFixture({ onProgress });
        const task = await f.delegate();
        f.state.step = 'Reading a.ts';

        f.service.observeChatProgress('unrelated-terminal');
        await f.finish(task, 'Summary: Done.');
        f.state.step = 'Editing b.ts';
        f.service.observeChatProgress(task.terminalId);

        expect(onProgress).not.toHaveBeenCalled();
    });

    it('reads and parses each task record once per request, whatever the entry derives from it', async () => {
        const f = await delegatedFixture();
        const first = await f.delegate();
        await f.finish(first, 'Summary: Done.');
        f.service.interruptTerminal(first.terminalId, true);
        const second = await f.delegate({ consult: true });
        f.start(second);

        const parse = vi.spyOn(JSON, 'parse');
        const sessions = f.service.sessions([f.callerSessionId]);
        const recordParses = parse.mock.calls.filter(
            ([text]) => typeof text === 'string' && text.includes('"fingerprint"'),
        );
        parse.mockRestore();

        expect(sessions).toHaveLength(2);
        expect(sessions).toContainEqual(
            expect.objectContaining({ delegationId: first.id, control: 'human' }),
        );
        expect(recordParses).toHaveLength(2);
    });
});
