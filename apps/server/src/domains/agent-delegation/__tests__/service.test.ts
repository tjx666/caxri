import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentLaunchSettings } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const owner = { principal: { kind: 'human-cli', id: 'owner' } } as const;

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-service-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'claude');
    database.createTerminal(session.id, 'shell');
    let launch: AgentLaunchSettings | undefined;
    const start = vi.fn<AgentDispatchService['start']>((_id, _principal, _input, options) => {
        launch = options?.launch;
        options?.prepared(terminal!);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const readTranscript = vi.fn().mockResolvedValue(null);
    const settings = { executable: 'claude', args: ['--model', 'sonnet'] };
    const service = new AgentDelegationService({
        database,
        dispatch: { start },
        userDataPath: directory,
        launchSettings: () => settings,
        verifyLaunch: () => Promise.resolve(),
        readTranscript,
    });
    onTestFinished(() => service.close());
    const id = randomUUID();
    const input = {
        projectId: project.id,
        sessionId: session.id,
        provider: 'claude' as const,
        prompt: 'Synthetic private task',
    };
    return {
        directory,
        database,
        terminal: terminal!,
        start,
        readTranscript,
        settings,
        service,
        id,
        input,
        launch: () => launch!,
    };
}

describe('AgentDelegationService', () => {
    it('preserves the launch failure when retiring a failed startup first reports interruption', async () => {
        const f = await fixture();
        f.start.mockImplementation((_id, _principal, _input, options) => {
            options?.prepared(f.terminal);
            f.service.bindLaunch(f.terminal.id, 'launch');
            f.service.interruptTerminal(f.terminal.id);
            return Promise.resolve({ status: 'failed' } as Awaited<
                ReturnType<AgentDispatchService['start']>
            >);
        });
        expect(await f.service.create(f.id, owner, f.input)).toMatchObject({
            status: 'failed',
            failure: 'launch_failed',
        });
    });

    it('rejects cross-Session and unrelated callers before launch or answer disclosure', async () => {
        const f = await fixture();
        const other = f.database.createSession(f.input.projectId, 'shell');
        const principal = {
            kind: 'agent' as const,
            id: 'caller',
            endpointId: 'endpoint',
            generation: 1,
            projectIds: [f.input.projectId],
        };
        await expect(
            f.service.create(f.id, { principal, callerTerminalId: other.terminal!.id }, f.input),
        ).rejects.toThrow(/caller Session/u);
        expect(f.start).not.toHaveBeenCalled();
        await f.service.create(f.id, owner, f.input);
        expect(() =>
            f.service.status(f.id, { principal, callerTerminalId: f.terminal.id }),
        ).toThrow(/another Agent/u);
    });

    it('returns a timeout without resending or interrupting the task', async () => {
        const f = await fixture();
        await f.service.create(f.id, owner, f.input);
        const before = f.service.status(f.id, owner);
        expect(await f.service.wait(f.id, owner, 0)).toEqual({
            receipt: before,
            answer: undefined,
            outcome: 'timeout',
        });
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.service.status(f.id, owner)).toEqual(before);
    });

    it('never treats a provider error response as an answer', async () => {
        const f = await fixture();
        await f.service.create(f.id, owner, f.input);
        f.service.bindLaunch(f.terminal.id, 'launch');
        const stored = f.database.agentDelegations.get(f.id)!;
        const signal = {
            terminalId: f.terminal.id,
            launchId: 'launch',
            provider: 'claude' as const,
            agentSessionId: stored.providerSessionId,
            agentTurnId: 'turn',
        };
        f.service.observe({
            ...signal,
            phase: 'turnStarted',
            agentPromptDigest: stored.promptDigest,
        });
        f.service.observe({ ...signal, phase: 'turnFinished', agentFailure: 'rate_limit' });
        expect((await f.service.result(f.id, owner)).receipt).toMatchObject({
            status: 'failed',
            failure: 'rate_limited',
        });
        expect(f.readTranscript).not.toHaveBeenCalled();
    });

    it('persists private input and frozen settings before one visible launch', async () => {
        const f = await fixture();
        await Promise.all([
            f.service.create(f.id, owner, f.input),
            f.service.create(f.id, owner, f.input),
        ]);
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.launch().args.join(' ')).not.toContain(f.input.prompt);
        const path = join(f.directory, 'delegations', f.id, 'task.md');
        expect(await readFile(path, 'utf8')).toBe(f.input.prompt);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        f.settings.args.push('--verbose');
        expect(f.database.agentDelegations.get(f.id)?.frozenLaunch.args).toEqual([
            '--model',
            'sonnet',
        ]);
        await expect(
            f.service.create(f.id, owner, { ...f.input, prompt: 'Different task' }),
        ).rejects.toThrow(/already used/u);
    });

    it('collects only the exact applied turn and keeps its answer through recovery', async () => {
        const f = await fixture();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
        onTestFinished(() => clock.mockRestore());
        await f.service.create(f.id, owner, f.input);
        expect(f.service.bindLaunch(f.terminal.id, 'launch')).toBe(true);
        const stored = f.database.agentDelegations.get(f.id)!;
        const signal = {
            terminalId: f.terminal.id,
            launchId: 'launch',
            provider: 'claude' as const,
            agentSessionId: stored.providerSessionId,
            agentTurnId: 'turn',
        };
        f.service.observe({
            ...signal,
            phase: 'turnStarted',
            agentPromptDigest: stored.promptDigest,
        });
        f.service.observe({
            ...signal,
            phase: 'turnFinished',
            agentTurnId: 'old',
            agentResponseDigest: digest('Answer'),
        });
        f.service.observe({
            ...signal,
            phase: 'turnFinished',
            agentId: 'child',
            agentResponseDigest: digest('Answer'),
        });
        expect(f.service.status(f.id, owner).status).toBe('running');
        f.service.observe({
            ...signal,
            phase: 'turnFinished',
            agentResponseDigest: digest('Answer'),
        });
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('collecting');
        f.readTranscript.mockResolvedValue({
            exists: true,
            truncated: false,
            path: 'synthetic',
            content: [
                {
                    type: 'user',
                    uuid: 'prompt',
                    parentUuid: null,
                    message: { content: f.launch().args.at(-1) },
                },
                {
                    type: 'assistant',
                    uuid: 'answer',
                    parentUuid: 'prompt',
                    message: { content: 'Answer' },
                },
            ]
                .map((row) => JSON.stringify({ ...row, sessionId: stored.providerSessionId }))
                .join('\n'),
        });
        clock.mockReturnValue(1300);
        expect((await f.service.result(f.id, owner)).answer?.text).toBe('Answer');
        f.service.initialize();
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('completed');
    });

    it('fences manual input during an asynchronous transcript read', async () => {
        const f = await fixture();
        await f.service.create(f.id, owner, f.input);
        f.service.bindLaunch(f.terminal.id, 'launch');
        const stored = f.database.agentDelegations.get(f.id)!;
        f.database.agentDelegations.save({
            ...stored,
            responseDigest: digest('Answer'),
            receipt: { ...stored.receipt, status: 'collecting' },
        });
        f.readTranscript.mockImplementation(() => {
            f.service.interruptTerminal(f.terminal.id, true);
            return Promise.resolve(null);
        });
        const result = await f.service.result(f.id, owner);
        expect(result.receipt.status).toBe('human_intervened');
        expect(result.answer).toBeUndefined();
    });

    it('shares a slow transcript read and throttles repeated result polling', async () => {
        const f = await fixture();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
        onTestFinished(() => clock.mockRestore());
        await f.service.create(f.id, owner, f.input);
        f.service.bindLaunch(f.terminal.id, 'launch');
        const stored = f.database.agentDelegations.get(f.id)!;
        f.database.agentDelegations.save({
            ...stored,
            responseDigest: digest('Answer'),
            receipt: { ...stored.receipt, status: 'collecting' },
        });
        const pending = Promise.withResolvers<null>();
        f.readTranscript.mockImplementation(() => pending.promise);
        const first = f.service.result(f.id, owner);
        await Promise.resolve();
        clock.mockReturnValue(1100);
        await Promise.all(Array.from({ length: 32 }, () => f.service.result(f.id, owner)));
        expect(f.readTranscript).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(1300);
        const joined = f.service.result(f.id, owner);
        await Promise.resolve();
        expect(f.readTranscript).toHaveBeenCalledTimes(1);
        pending.resolve(null);
        await Promise.all([first, joined]);
    });

    it('marks unfinished work interrupted on recovery without resubmission', async () => {
        const f = await fixture();
        await f.service.create(f.id, owner, f.input);
        f.service.initialize();
        expect((await f.service.create(f.id, owner, f.input)).failure).toBe('host_reset');
        expect(f.start).toHaveBeenCalledTimes(1);
    });
});
