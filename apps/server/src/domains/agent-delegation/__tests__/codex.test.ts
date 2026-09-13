import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentTranscript } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

const owner = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;
const nativeId = '019e676d-8740-7bb2-8bcb-f189c8260607';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-delegation-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'codex');
    database.createTerminal(session.id, 'shell');
    const state = { launch: 'first-launch', content: '', offset: 0, time: 1, isFinished: false };
    vi.spyOn(performance, 'now').mockImplementation(() => state.time);
    const pointers = new Map<string, string>();
    const start = vi.fn<AgentDispatchService['start']>((id, _principal, _input, options) => {
        options!.prepared(terminal!);
        pointers.set(id, options!.launch.args.at(-1)!);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const resume = vi.fn<AgentDispatchService['resume']>((id, _principal, _input, options) => {
        options!.beforeResume();
        pointers.set(id, options!.initialPrompt);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['resume']>
        >);
    });
    const write = vi.fn<(terminalId: string, launchId: string, data: string) => boolean>(
        () => true,
    );
    const readNativeTranscript = vi.fn(() =>
        Promise.resolve({
            content: state.content,
            offset: state.offset,
            isFinished: state.isFinished,
        }),
    );
    const readTranscript = vi.fn<() => Promise<AgentTranscript | null>>(() =>
        Promise.resolve(null),
    );
    const options = {
        database,
        dispatch: { start, resume },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'codex', args: ['--sandbox', 'read-only'] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript,
        readNativeTranscript,
        currentLaunchId: () => state.launch,
        inputEpoch: () => 0,
        isIdle: () => true,
        write,
        now: () => state.time,
    };
    const services: AgentDelegationService[] = [];
    const createService = () => {
        const service = new AgentDelegationService(options);
        services.push(service);
        return service;
    };
    const service = createService();
    onTestFinished(async () => {
        for (const item of services) item.close();
        database.close();
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });
    const input = {
        projectId: project.id,
        sessionId: session.id,
        provider: 'codex' as const,
        prompt: 'Synthetic initial task',
    };
    const id = randomUUID();
    await service.create(id, owner, input);
    service.bindLaunch(terminal!.id, state.launch);
    database.rebindAgentSession(terminal!.id, 'codex', nativeId);
    const begin = (taskId: string) => {
        const pointer = pointers.get(taskId) ?? write.mock.calls.at(-1)![2].slice(6, -7);
        service.observe({
            terminalId: terminal!.id,
            launchId: state.launch,
            provider: 'codex',
            agentSessionId: nativeId,
            phase: 'turnStarted',
            agentTurnId: `turn-${taskId}`,
            agentPromptDigest: digest(pointer),
        });
    };
    const complete = (taskId: string, answer: string) => {
        state.content = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${taskId}`, last_agent_message: answer } })}\n`;
        state.offset += state.content.length;
        state.time += 2_001;
    };
    begin(id);
    return {
        service,
        createService,
        database,
        terminal: terminal!,
        state,
        readNativeTranscript,
        pointers,
        readTranscript,
        resume,
        write,
        id,
        input,
        begin,
        complete,
    };
}

describe('Visible Codex delegation', () => {
    it('bounds missing result collection only after the exact native turn has finished', async () => {
        const f = await fixture();
        f.state.time = 20_000;
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('running');
        f.state.isFinished = true;
        f.state.time += 2_001;
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('collecting');
        f.state.time += 15_001;
        expect(await f.service.result(f.id, owner)).toMatchObject({
            receipt: { status: 'answer_unavailable', failure: 'result_missing' },
        });
    });
    it('recovers a persisted final event after Server restart without replaying the task', async () => {
        const f = await fixture();
        f.service.close();
        f.complete(f.id, 'Durable synthetic answer');
        const restored = f.createService();
        restored.initialize();
        expect(await restored.result(f.id, owner)).toMatchObject({
            receipt: { status: 'completed' },
            answer: { text: 'Durable synthetic answer' },
        });
        expect(f.write).not.toHaveBeenCalled();
    });
    it('keeps a nonfinal Stop cancelable beyond the Claude collection deadline', async () => {
        const f = await fixture();
        f.service.observe({
            terminalId: f.terminal.id,
            launchId: f.state.launch,
            provider: 'codex',
            agentSessionId: nativeId,
            phase: 'turnFinished',
            agentTurnId: `turn-${f.id}`,
            agentResponseDigest: digest('Intermediate synthetic answer'),
        });
        f.state.time += 20_000;
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('running');
        expect(f.service.stop(f.id, owner)).toMatchObject({
            status: 'interrupted',
            failure: 'caller_stopped',
        });
        expect(f.write).toHaveBeenLastCalledWith(
            f.terminal.id,
            f.state.launch,
            '\u{1B}',
            expect.any(Function),
        );
        f.complete(f.id, 'Late synthetic answer');
        expect((await f.service.result(f.id, owner)).answer).toBeUndefined();
    });
    it('returns separate exact answers for same-Terminal follow-up and native resume', async () => {
        const f = await fixture();
        f.complete(f.id, 'Initial synthetic answer');
        expect((await f.service.result(f.id, owner)).answer?.text).toBe('Initial synthetic answer');
        const follow = randomUUID();
        await f.service.create(follow, owner, { ...f.input, followUpOf: f.id });
        f.begin(follow);
        f.complete(follow, 'Follow-up synthetic answer');
        expect((await f.service.result(follow, owner)).answer?.text).toBe(
            'Follow-up synthetic answer',
        );
        const resumed = randomUUID();
        await f.service.create(resumed, owner, { ...f.input, resumeFrom: follow });
        expect(f.resume.mock.calls[0][2].providerSessionId).toBe(nativeId);
        expect(f.resume.mock.calls[0][3]!.launch.args).not.toContain('--add-dir');
        f.state.launch = 'resumed-launch';
        f.service.bindLaunch(f.terminal.id, f.state.launch);
        f.begin(resumed);
        f.complete(resumed, 'Resumed synthetic answer');
        expect(await f.service.result(resumed, owner)).toMatchObject({
            receipt: { status: 'completed', terminalId: f.terminal.id },
            answer: { text: 'Resumed synthetic answer' },
        });
        expect((await f.service.result(f.id, owner)).answer?.text).toBe('Initial synthetic answer');
    });
    it('settles native errors without requiring a Stop hook', async () => {
        const f = await fixture();
        f.state.content = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${f.id}`, error: { codex_error_info: 'usage_limit_exceeded', message: 'Synthetic private diagnostic' } } })}\n`;
        expect(await f.service.result(f.id, owner)).toMatchObject({
            receipt: { status: 'failed', failure: 'quota_exhausted' },
        });
    });
    it('rejects changing provider while continuing an existing task', async () => {
        const f = await fixture();
        await expect(
            f.service.create(randomUUID(), owner, {
                ...f.input,
                provider: 'claude',
                followUpOf: f.id,
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it('discards a native read invalidated by human takeover', async () => {
        const f = await fixture();
        const { promise, resolve } = Promise.withResolvers<{
            content: string;
            offset: number;
            isFinished: boolean;
        }>();
        f.readNativeTranscript.mockImplementationOnce(() => promise);
        const pending = f.service.result(f.id, owner);
        await Promise.resolve();
        f.service.interruptTerminal(f.terminal.id, true);
        f.complete(f.id, 'Must not be returned');
        resolve({ content: f.state.content, offset: f.state.offset, isFinished: false });
        expect(await pending).toMatchObject({ receipt: { status: 'human_intervened' } });
        expect((await f.service.result(f.id, owner)).answer).toBeUndefined();
    });
    it('preserves a proven answer when optional accounting evidence cannot be read', async () => {
        const f = await fixture();
        f.complete(f.id, 'Synthetic completed answer');
        f.readTranscript.mockRejectedValue(new Error('Synthetic unavailable usage evidence'));
        const result = await f.service.result(f.id, owner);
        expect(result).toMatchObject({
            receipt: { status: 'completed' },
            answer: { text: 'Synthetic completed answer' },
        });
        expect(result.receipt.usage).toBeUndefined();
    });
    it('fences human takeover while reading optional accounting after native completion', async () => {
        const f = await fixture();
        const pendingRead = Promise.withResolvers<AgentTranscript | null>();
        f.complete(f.id, 'Synthetic completed answer');
        f.readTranscript.mockImplementationOnce(() => pendingRead.promise);
        const pending = f.service.result(f.id, owner);
        await vi.waitFor(() => expect(f.readTranscript).toHaveBeenCalledOnce());
        f.service.interruptTerminal(f.terminal.id, true);
        pendingRead.resolve(null);
        expect(await pending).toMatchObject({ receipt: { status: 'human_intervened' } });
        expect((await f.service.result(f.id, owner)).answer).toBeUndefined();
    });
    it.each(['completed', 'quota_exhausted', 'payload_overflow'])(
        'persists exact native usage across restart for %s',
        async (outcome) => {
            const f = await fixture();
            f.complete(
                f.id,
                outcome === 'payload_overflow' ? 'a'.repeat(65_537) : 'Synthetic completed answer',
            );
            if (outcome === 'quota_exhausted')
                f.state.content = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${f.id}`, error: { codex_error_info: 'usage_limit_exceeded' } } })}\n`;
            const content = [
                JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'task_started', turn_id: `turn-${f.id}` },
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'token_count',
                        info: { total_token_usage: { input_tokens: 30, output_tokens: 5 } },
                    },
                }),
                f.state.content,
            ].join('\n');
            f.readTranscript.mockResolvedValue({
                path: '/synthetic/transcript',
                exists: true,
                truncated: false,
                content,
            });
            const result = await f.service.result(f.id, owner);
            expect(result.receipt.failure).toBe(outcome === 'completed' ? undefined : outcome);
            expect(result.receipt.usage).toMatchObject({
                inputTokens: 30,
                outputTokens: 5,
            });
            f.service.close();
            const restarted = f.createService();
            restarted.initialize();
            expect((await restarted.result(f.id, owner)).receipt.usage).toMatchObject({
                inputTokens: 30,
                outputTokens: 5,
            });
            expect(f.readTranscript).toHaveBeenCalledOnce();
        },
    );
});
