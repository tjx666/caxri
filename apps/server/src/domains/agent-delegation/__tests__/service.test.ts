import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
    it('confines external clients to their bound caller and Session and rejects sibling client access', async () => {
        const f = await fixture();
        const authority = {
            principal: {
                kind: 'delegation-client' as const,
                id: 'external-one',
                clientId: 'client-one',
                generation: 1,
                projectIds: [f.input.projectId] as [string],
                sessionId: f.input.sessionId,
                callerProvider: 'codex' as const,
            },
        };
        await expect(
            f.service.create(randomUUID(), authority, { ...f.input, callerProvider: 'grok' }),
        ).rejects.toThrow('authorized provider');
        const otherSession = f.database.createSession(f.input.projectId, null).session;
        await expect(
            f.service.create(randomUUID(), authority, { ...f.input, sessionId: otherSession.id }),
        ).rejects.toThrow('authorized external Session');
        await f.service.create(f.id, authority, f.input);
        expect(() =>
            f.service.status(f.id, {
                principal: { ...authority.principal, id: 'external-two', clientId: 'client-two' },
            }),
        ).toThrow('another Agent');
        const record = f.database.agentDelegations.get(f.id)!;
        for (let index = 0; index < 3; index += 1)
            f.database.agentDelegations.insert({
                ...record,
                receipt: { ...record.receipt, delegationId: randomUUID() },
            });
        await expect(f.service.create(randomUUID(), authority, f.input)).rejects.toThrow(
            'four active',
        );
        expect(f.start).toHaveBeenCalledOnce();
    });
    it('retains metadata when private-file cleanup fails and permits an explicit retry', async () => {
        const f = await fixture();
        await f.service.create(f.id, owner, f.input);
        const root = join(f.directory, 'delegations');
        await chmod(root, 0o755);
        const removeRecords = vi.fn(() => f.database.deleteSession(f.input.sessionId));
        await expect(
            f.service.deleteSessions([f.input.sessionId], removeRecords),
        ).rejects.toThrow();
        expect(removeRecords).not.toHaveBeenCalled();
        expect(f.database.agentDelegations.get(f.id)).toBeDefined();
        await chmod(root, 0o700);
        await f.service.deleteSessions([f.input.sessionId], removeRecords);
        expect(removeRecords).toHaveBeenCalledOnce();
    });

    it('drains an admitted create before deleting its private files and Session metadata', async () => {
        const f = await fixture();
        const pending = Promise.withResolvers<Awaited<ReturnType<AgentDispatchService['start']>>>();
        f.start.mockImplementation(() => pending.promise);
        const creation = f.service.create(f.id, owner, f.input);
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
        const removeRecords = vi.fn(() => f.database.deleteSession(f.input.sessionId));
        const deletion = f.service.deleteSessions([f.input.sessionId], removeRecords);
        await expect(f.service.create(randomUUID(), owner, f.input)).rejects.toThrow(/delet/u);
        expect(removeRecords).not.toHaveBeenCalled();
        pending.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
        await expect(creation).rejects.toThrow(/delet/u);
        await deletion;
        expect(removeRecords).toHaveBeenCalledOnce();
        expect(f.database.getSession(f.input.sessionId)).toBeUndefined();
        await expect(stat(join(f.directory, 'delegations', f.id))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('does not revive a task stopped while dispatch is validating its working directory', async () => {
        const f = await fixture();
        f.start.mockImplementation((_id, _principal, _input, options) => {
            f.service.stop(f.id, owner);
            options?.beforeCreate?.();
            options?.prepared(f.terminal);
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['start']>
            >);
        });
        expect(await f.service.create(f.id, owner, f.input)).toMatchObject({
            status: 'interrupted',
            failure: 'caller_stopped',
        });
    });

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

    it('fills an Agent Commander Session pane without anchoring to the out-of-Session caller', async () => {
        const f = await fixture();
        const commanderRoot = await mkdtemp(join(tmpdir(), 'caxri-delegation-commander-'));
        onTestFinished(() => rm(commanderRoot, { recursive: true, force: true }));
        const commanderProject = f.database.createProject(commanderRoot);
        const commander = f.database.createSession(commanderProject.id, 'codex');
        const target = f.database.createSession(f.input.projectId, null).session;
        f.database.setAppState('agentCommander', {
            projectId: commanderProject.id,
            sessionId: commander.session.id,
            terminalId: commander.terminal!.id,
            sessionIds: [target.id],
        });
        let launched: string | undefined;
        f.start.mockImplementation((_id, _principal, _input, options) => {
            const terminal = f.database.createTerminal(target.id, 'claude');
            launched = terminal.id;
            options?.prepared(terminal);
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['start']>
            >);
        });
        const authority = {
            principal: {
                kind: 'agent' as const,
                id: 'commander',
                endpointId: 'commander',
                generation: 1,
                projectIds: [commanderProject.id],
            },
            callerTerminalId: commander.terminal!.id,
        };

        const receipt = await f.service.create(f.id, authority, {
            ...f.input,
            sessionId: target.id,
        });

        expect(receipt.terminalId).toBe(launched);
        expect(f.start.mock.calls[0]?.[3]?.cwd).toBeUndefined();
        expect(JSON.stringify(f.database.getSessionState(target.id).paneLayout)).toContain(
            launched!,
        );
        expect(f.service.status(f.id, authority).delegationId).toBe(f.id);
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
        expect(f.service.stop(f.id, owner).status).toBe('collecting');
        f.service.initialize();
        expect(f.service.status(f.id, owner).status).toBe('collecting');
        expect(f.start).toHaveBeenCalledTimes(1);
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
