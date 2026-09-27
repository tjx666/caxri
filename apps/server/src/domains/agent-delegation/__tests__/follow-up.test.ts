import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

const owner = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(submissionTimeoutMs = 1000) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-follow-up-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'claude');
    database.createTerminal(session.id, 'shell');
    const state = { epoch: 0, launch: 'launch' as string | undefined, isIdle: true };
    const pointers = new Map<string, string>();
    const readTranscript = vi.fn().mockResolvedValue(null);
    const write = vi.fn<
        (
            terminalId: string,
            launchId: string,
            data: string,
            onDelivered?: (wasAccepted: boolean) => void,
        ) => boolean
    >(() => true);
    const start = vi.fn<AgentDispatchService['start']>((id, _principal, _input, options) => {
        options!.prepared(terminal!);
        pointers.set(id, options!.launch.args.at(-1)!);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const settings = { executable: 'claude', args: ['--model', 'sonnet'] };
    const verifyLaunch = vi.fn(() => Promise.resolve());
    const resume = vi.fn<AgentDispatchService['resume']>((id, _principal, _input, options) => {
        options!.beforeResume();
        pointers.set(id, options!.initialPrompt);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['resume']>
        >);
    });
    const loggerWrite = vi.fn<StructuredLogger['write']>();
    const service = new AgentDelegationService({
        database,
        dispatch: { start, resume },
        logger: { write: loggerWrite } as unknown as StructuredLogger,
        userDataPath: directory,
        launchSettings: () => settings,
        verifyLaunch,
        readTranscript,
        inputEpoch: () => state.epoch,
        currentLaunchId: () => state.launch,
        isIdle: () => state.isIdle,
        write,
        submissionTimeoutMs,
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const input = {
        projectId: project.id,
        sessionId: session.id,
        provider: 'claude' as const,
        prompt: 'Synthetic initial task',
    };
    const id = randomUUID();
    await service.create(id, owner, input);
    service.bindLaunch(terminal!.id, 'launch');
    database.rebindAgentSession(
        terminal!.id,
        'claude',
        database.agentDelegations.get(id)!.providerSessionId!,
    );
    const finish = async (taskId: string, answer: string) => {
        const record = database.agentDelegations.get(taskId)!;
        const pointer = pointers.get(taskId) ?? write.mock.calls.at(-1)![2].slice(6, -7);
        const signal = {
            terminalId: terminal!.id,
            launchId: 'launch',
            provider: 'claude' as const,
            agentSessionId: record.providerSessionId,
            agentTurnId: `turn-${taskId}`,
        };
        service.observe({ ...signal, phase: 'turnStarted', agentPromptDigest: digest(pointer) });
        readTranscript.mockResolvedValue({
            content: [
                {
                    sessionId: record.providerSessionId,
                    type: 'user',
                    uuid: taskId,
                    message: { content: pointer },
                },
                {
                    sessionId: record.providerSessionId,
                    type: 'assistant',
                    uuid: `answer-${taskId}`,
                    parentUuid: taskId,
                    message: { content: answer },
                },
            ]
                .map((row) => JSON.stringify(row))
                .join('\n'),
        });
        service.observe({ ...signal, phase: 'turnFinished', agentResponseDigest: digest(answer) });
        return service.result(taskId, owner);
    };
    expect((await finish(id, 'Synthetic first answer')).receipt.status).toBe('completed');
    /**
     * Replays what the Terminal Host eventually said about the most recent write, which a background delegation only
     * learns after its input was already admitted.
     */
    const deliver = (wasAccepted: boolean) => write.mock.calls.at(-1)![3]!(wasAccepted);
    /**
     * The closed reasons this service recorded for admissions it refused, oldest first.
     */
    const rejections = () =>
        loggerWrite.mock.calls
            .filter((call) => call[1] === 'agent_delegation.admission_rejected')
            .map((call) => call[2]?.fields);
    return {
        deliver,
        rejections,
        directory,
        database,
        terminal: terminal!,
        state,
        pointers,
        readTranscript,
        write,
        start,
        resume,
        settings,
        verifyLaunch,
        service,
        input,
        id,
        finish,
    };
}

describe('Visible same-Terminal follow-up', () => {
    it('deletes only owned storage roots, not a directory named after a child task', async () => {
        const f = await fixture();
        const id = randomUUID();
        await f.service.create(id, owner, { ...f.input, followUpOf: f.id });
        const unrelated = join(f.directory, 'delegations', id);
        await mkdir(unrelated);
        await writeFile(join(unrelated, 'sentinel'), 'Unrelated synthetic file');
        await f.service.deleteSessions([f.input.sessionId], () =>
            f.database.deleteSession(f.input.sessionId),
        );
        await expect(stat(join(f.directory, 'delegations', f.id))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(await readFile(join(unrelated, 'sentinel'), 'utf8')).toBe(
            'Unrelated synthetic file',
        );
    });

    it('does not bind a concurrent manual launch to a delegation waiting at the restart barrier', async () => {
        const f = await fixture();
        f.resume.mockImplementation((_id, _principal, _input, options) => {
            options!.beforeResume();
            f.service.bindEnvironment(f.terminal.id, 'manual-launch', {
                CAXRI_HOOK_TOKEN: 'synthetic',
            });
            expect(options!.shouldStart!()).toBe(false);
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['resume']>
            >);
        });
        const id = randomUUID();
        expect(await f.service.create(id, owner, { ...f.input, resumeFrom: f.id })).toMatchObject({
            status: 'interrupted',
            failure: 'target_changed',
        });
        expect(f.database.agentDelegations.get(id)?.launchId).toBeUndefined();
    });

    it('revalidates the native binary before starting a resumed task', async () => {
        const f = await fixture();
        f.verifyLaunch.mockRejectedValue(new Error('Unsupported native version'));
        await expect(
            f.service.create(randomUUID(), owner, { ...f.input, resumeFrom: f.id }),
        ).rejects.toThrow('Unsupported native version');
        expect(f.resume).not.toHaveBeenCalled();
    });

    it('retains loss of launch ownership when a manual native resume is followed by Server restart', async () => {
        const f = await fixture();
        f.service.bindEnvironment(f.terminal.id, 'manual-launch', {});
        f.state.launch = undefined;
        f.service.initialize();
        expect(
            await f.service.create(randomUUID(), owner, { ...f.input, resumeFrom: f.id }),
        ).toMatchObject({ status: 'failed', failure: 'target_changed' });
        expect(f.resume).not.toHaveBeenCalled();
    });

    it('retains human takeover of a completed task when restart resets the in-memory input epoch', async () => {
        const f = await fixture();
        f.state.epoch = 1;
        f.service.interruptTerminal(f.terminal.id, true);
        f.state.epoch = 0;
        f.state.launch = undefined;
        f.service.initialize();
        expect(
            await f.service.create(randomUUID(), owner, { ...f.input, resumeFrom: f.id }),
        ).toMatchObject({ status: 'failed', failure: 'human_input' });
        expect(f.resume).not.toHaveBeenCalled();
        expect((await f.service.result(f.id, owner)).answer?.text).toBe('Synthetic first answer');
    });

    it('resumes the exact native identity once with frozen settings and a fresh task pointer', async () => {
        const f = await fixture();
        f.state.launch = undefined;
        f.settings.args = ['--model', 'different'];
        const id = randomUUID();
        const input = { ...f.input, resumeFrom: f.id, prompt: 'Synthetic resumed task' };
        const [first, retry] = await Promise.all([
            f.service.create(id, owner, input),
            f.service.create(id, owner, input),
        ]);
        expect(first).toEqual(retry);
        expect(first).toMatchObject({ status: 'launching', terminalId: f.terminal.id });
        expect(f.resume).toHaveBeenCalledTimes(1);
        expect(f.resume.mock.calls[0][2]).toMatchObject({
            terminalId: f.terminal.id,
            providerSessionId: f.database.agentDelegations.get(f.id)!.providerSessionId,
        });
        expect(f.resume.mock.calls[0][3]).toMatchObject({
            launch: {
                args: ['--model', 'sonnet', '--add-dir', join(f.directory, 'delegations', f.id)],
            },
        });
        expect(f.pointers.get(id)).not.toBe(f.pointers.get(f.id));
        expect(f.pointers.get(id)).not.toContain(input.prompt);
        expect(f.write).not.toHaveBeenCalled();
        f.service.bindLaunch(f.terminal.id, 'launch');
        expect((await f.finish(id, 'Synthetic resumed answer')).answer?.text).toBe(
            'Synthetic resumed answer',
        );
    });

    it.each([
        ['human_input', 'input_epoch_moved', { epoch: 1 }],
        ['target_changed', 'launch_replaced', { launch: 'unrelated-launch' }],
    ] as const)('rejects unsafe resume after %s', async (failure, reason, patch) => {
        const f = await fixture();
        Object.assign(f.state, patch);
        const id = randomUUID();
        expect(await f.service.create(id, owner, { ...f.input, resumeFrom: f.id })).toMatchObject({
            status: 'failed',
            failure,
        });
        expect(f.resume).not.toHaveBeenCalled();
        expect(f.rejections()).toEqual([{ delegationId: id, phase: 'resume', reason, failure }]);
    });

    it('submits once in the original native session and frozen configuration, preserving both answers', async () => {
        const f = await fixture();
        const id = randomUUID();
        f.settings.args = ['--model', 'different'];
        const input = { ...f.input, followUpOf: f.id, prompt: 'Synthetic follow-up task' };
        const [first, retry] = await Promise.all([
            f.service.create(id, owner, input),
            f.service.create(id, owner, input),
        ]);
        expect(first).toEqual(retry);
        expect(first).toMatchObject({
            status: 'submitting',
            terminalId: f.terminal.id,
            followUpOf: f.id,
        });
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.write).toHaveBeenCalledTimes(1);
        expect(f.write.mock.calls[0].slice(0, 2)).toEqual([f.terminal.id, 'launch']);
        expect(f.write.mock.calls[0][2].startsWith('\u{1B}[200~Read')).toBe(true);
        expect(f.write.mock.calls[0][2].endsWith('\u{1B}[201~\r')).toBe(true);
        expect(f.write.mock.calls[0][2]).not.toContain(input.prompt);
        expect(await readFile(join(f.directory, 'delegations', f.id, `${id}.md`), 'utf8')).toBe(
            input.prompt,
        );
        expect(f.database.agentDelegations.get(id)).toMatchObject({
            providerSessionId: f.database.agentDelegations.get(f.id)!.providerSessionId,
            frozenLaunch: { args: ['--model', 'sonnet'] },
        });
        expect((await f.finish(id, 'Synthetic second answer')).answer?.text).toBe(
            'Synthetic second answer',
        );
        expect((await f.service.result(f.id, owner)).answer?.text).toBe('Synthetic first answer');
        await expect(f.service.create(id, owner, { ...input, followUpOf: id })).rejects.toThrow(
            /already used/u,
        );
    });

    /**
     * The reason is asserted beside the failure because the failure alone cannot be investigated: three of these four
     * rejections arrive at the caller as the same word, and separating them is the whole point of the closed reason
     * enum (github.com/tjx666/caxri/issues/933).
     */
    it.each([
        ['human_input', 'input_epoch_moved', { epoch: 1 }],
        ['target_not_ready', 'target_not_idle', { isIdle: false }],
        ['target_changed', 'launch_replaced', { launch: 'new-launch' }],
        ['target_changed', 'launch_replaced', { launch: undefined }],
    ] as const)('rejects %s without writing into the native UI', async (failure, reason, patch) => {
        const f = await fixture();
        Object.assign(f.state, patch);
        const id = randomUUID();
        expect(await f.service.create(id, owner, { ...f.input, followUpOf: f.id })).toMatchObject({
            status: 'failed',
            failure,
        });
        expect(f.write).not.toHaveBeenCalled();
        expect(f.rejections()).toEqual([{ delegationId: id, phase: 'follow_up', reason, failure }]);
    });

    /**
     * These two refusals never consult the live Terminal: the parent record itself lacks the launch or native session a
     * follow-up would have to reuse. They reach the caller as the same `target_changed` a replaced launch reports, so
     * the CI reading of that failure (github.com/tjx666/caxri/issues/933) needs the reason to tell them apart.
     */
    it.each([
        ['no_launch', { launchId: undefined }],
        ['no_provider_session', { providerSessionId: undefined }],
    ] as const)(
        'rejects a parent whose record lacks %s as target_changed',
        async (reason, patch) => {
            const f = await fixture();
            f.database.agentDelegations.save({
                ...f.database.agentDelegations.get(f.id)!,
                ...patch,
            });
            const id = randomUUID();
            expect(
                await f.service.create(id, owner, { ...f.input, followUpOf: f.id }),
            ).toMatchObject({
                status: 'failed',
                failure: 'target_changed',
            });
            expect(f.write).not.toHaveBeenCalled();
            expect(f.rejections()).toEqual([
                { delegationId: id, phase: 'follow_up', reason, failure: 'target_changed' },
            ]);
        },
    );

    it('separates a Host-refused write from a launch that changed before admission', async () => {
        const f = await fixture();
        f.write.mockReturnValueOnce(false);
        const id = randomUUID();
        expect(await f.service.create(id, owner, { ...f.input, followUpOf: f.id })).toMatchObject({
            status: 'failed',
            failure: 'target_changed',
        });
        expect(f.rejections()).toEqual([
            {
                delegationId: id,
                phase: 'follow_up',
                reason: 'write_refused',
                failure: 'target_changed',
            },
        ]);
    });

    /**
     * A follow-up claims its parent before writing, so a second child cannot fork the same conversation. A prompt the
     * Terminal Host refused before taking any input never reached the Agent, so the claim must not outlive it: a retry
     * was rejected as `target_busy` forever, and the task could no longer be continued at all.
     */
    it('lets a retry continue a task whose follow-up the Host refused before taking input', async () => {
        const f = await fixture();
        f.write.mockReturnValueOnce(false);
        const refused = randomUUID();
        expect(
            await f.service.create(refused, owner, { ...f.input, followUpOf: f.id }),
        ).toMatchObject({ status: 'failed', failure: 'target_changed' });

        const retry = randomUUID();
        expect(
            await f.service.create(retry, owner, { ...f.input, followUpOf: f.id }),
        ).toMatchObject({ status: 'submitting' });
        expect(f.write).toHaveBeenCalledTimes(2);
        expect((await f.finish(retry, 'Synthetic retried answer')).receipt.status).toBe(
            'completed',
        );
    });

    it.each(['followUpOf', 'resumeFrom'] as const)(
        'never continues a refused follow-up through %s, which would fork its parent',
        async (link) => {
            const f = await fixture();
            f.write.mockReturnValueOnce(false);
            const refused = randomUUID();
            await f.service.create(refused, owner, { ...f.input, followUpOf: f.id });

            expect(
                await f.service.create(randomUUID(), owner, { ...f.input, [link]: refused }),
            ).toMatchObject({ status: 'failed', failure: 'target_changed' });
            expect(f.write).toHaveBeenCalledTimes(1);
            expect(f.resume).not.toHaveBeenCalled();
        },
    );

    /**
     * The Host's later "not delivered" also covers a lost acknowledgement, and a timeout proves nothing either way; in
     * both cases the prompt may be in the conversation, so a retry must not submit a second one.
     */
    it.each([
        [
            'reported refused after admission',
            1000,
            (f: Awaited<ReturnType<typeof fixture>>) => f.deliver(false),
        ],
        ['never confirmed', 20, undefined],
    ] as const)(
        'keeps a task claimed when its follow-up was %s',
        async (_, submissionTimeoutMs, settle) => {
            const f = await fixture(submissionTimeoutMs);
            const uncertain = randomUUID();
            await f.service.create(uncertain, owner, { ...f.input, followUpOf: f.id });
            settle?.(f);
            await vi.waitFor(() =>
                expect(f.service.status(uncertain, owner)).toMatchObject({ status: 'failed' }),
            );

            expect(
                await f.service.create(randomUUID(), owner, { ...f.input, followUpOf: f.id }),
            ).toMatchObject({ status: 'failed', failure: 'target_busy' });
            expect(f.write).toHaveBeenCalledTimes(1);
        },
    );

    it('admits one child of a settled task when two different follow-ups race', async () => {
        const f = await fixture();
        const receipts = await Promise.all(
            [randomUUID(), randomUUID()].map((id) =>
                f.service.create(id, owner, { ...f.input, followUpOf: f.id }),
            ),
        );
        expect(
            receipts.map((receipt) => receipt.status).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['failed', 'submitting']);
        expect(receipts.find((receipt) => receipt.status === 'failed')?.failure).toBe(
            'target_busy',
        );
        expect(f.write).toHaveBeenCalledTimes(1);
    });

    it('reports missing submission confirmation without replaying the task', async () => {
        const f = await fixture(20);
        const id = randomUUID();
        await f.service.create(id, owner, { ...f.input, followUpOf: f.id });
        await vi.waitFor(() =>
            expect(f.service.status(id, owner)).toMatchObject({
                status: 'failed',
                failure: 'submission_unconfirmed',
            }),
        );
        expect(f.write).toHaveBeenCalledTimes(1);
    });

    it('stops the exact active task once and ignores a late completion', async () => {
        const f = await fixture();
        const id = randomUUID();
        await f.service.create(id, owner, { ...f.input, followUpOf: f.id });
        const stopped = f.service.stop(id, owner);
        expect(stopped).toMatchObject({ status: 'interrupted', failure: 'caller_stopped' });
        expect(f.service.stop(id, owner)).toEqual(stopped);
        expect(f.write.mock.calls.at(-1)).toEqual([
            f.terminal.id,
            'launch',
            '\u{1B}',
            expect.any(Function),
        ]);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect((await f.finish(id, 'Late synthetic answer')).receipt).toEqual(stopped);
    });

    /**
     * A background Terminal has no Renderer attachment, so its write is admitted before the Terminal Host has seen it:
     * the launch can change while the Host is still starting, or the Host can refuse the request. Reported as success,
     * the task sat in `submitting` for the full 15s timeout and then blamed `submission_unconfirmed`, and a Stop
     * claimed `caller_stopped` for an Esc that was never written (github.com/tjx666/caxri/issues/893).
     */
    it('settles a follow-up the Terminal Host refused after its prompt was admitted', async () => {
        const f = await fixture();
        const id = randomUUID();
        expect(await f.service.create(id, owner, { ...f.input, followUpOf: f.id })).toMatchObject({
            status: 'submitting',
        });

        f.deliver(false);

        expect(f.service.status(id, owner)).toMatchObject({
            status: 'failed',
            failure: 'target_changed',
        });
    });

    it('leaves a follow-up waiting for its turn once the Host confirms the prompt', async () => {
        const f = await fixture();
        const id = randomUUID();
        await f.service.create(id, owner, { ...f.input, followUpOf: f.id });

        f.deliver(true);

        expect(f.service.status(id, owner)).toMatchObject({ status: 'submitting' });
    });

    it('records a Stop the Terminal Host refused as a lost target, not a caller stop', async () => {
        const f = await fixture();
        const id = randomUUID();
        await f.service.create(id, owner, { ...f.input, followUpOf: f.id });
        f.deliver(true);
        expect(f.service.stop(id, owner)).toMatchObject({
            status: 'interrupted',
            failure: 'caller_stopped',
        });

        f.deliver(false);

        expect(f.service.status(id, owner)).toMatchObject({
            status: 'interrupted',
            failure: 'target_changed',
        });
    });
});
