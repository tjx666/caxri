import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { botHandoverAccess, BotHandoverService } from '../../bot';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

const conversationId = '019e676d-8740-7bb2-8bcb-f189c8260607';

/**
 * A Caxri Bot that has been handed a user Session whose Agent holds a Codex conversation, as a PTY Agent or as an Agent
 * Chat. `state.launch` is the Agent's live launch, `undefined` once its process stopped; `state.isChatLive` says
 * whether a Chat's provider runs, including while it starts or stops.
 */
async function fixture(surface: 'pty' | 'chat' = 'pty') {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-handover-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const botRoot = join(directory, 'bot');
    const workRoot = join(directory, 'work');
    await mkdir(botRoot);
    await mkdir(workRoot);
    const botProject = database.createProject(botRoot);
    const bot = database.createSession(botProject.id, 'codex');
    database.setAppState('caxriBot', {
        projectId: botProject.id,
        sessionId: bot.session.id,
        terminalId: bot.terminal!.id,
        sessionIds: [],
    });
    const project = database.createProject(workRoot);
    const created = surface === 'pty' ? database.createSession(project.id, 'codex') : undefined;
    const session = created?.session ?? database.createSession(project.id, null).session;
    const terminal =
        created?.terminal ?? database.createTerminal(session.id, 'codex', workRoot, 'chat');
    database.rebindAgentSession(terminal.id, 'codex', conversationId);
    const handovers = new BotHandoverService({
        database,
        notify: vi.fn(),
        resolveProjectRoot: (path) => Promise.resolve(path),
        sendFullStateChange: vi.fn(),
    });
    const state: { launch: string | undefined; epoch: number; isChatLive: boolean } = {
        launch: 'user-launch',
        epoch: 0,
        isChatLive: surface === 'chat',
    };
    const start = vi.fn<AgentDispatchService['start']>();
    const resume = vi.fn<AgentDispatchService['resume']>((_id, _principal, _input, options) => {
        options!.beforeResume();
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['resume']>
        >);
    });
    const inputEpoch = vi.fn<NonNullable<AgentDelegationServiceOptions['inputEpoch']>>(
        () => state.epoch,
    );
    const write = vi.fn<NonNullable<AgentDelegationServiceOptions['write']>>(() => true);
    const verifyLaunch = vi.fn<AgentDelegationServiceOptions['verifyLaunch']>(() =>
        Promise.resolve(),
    );
    const service = new AgentDelegationService({
        database,
        dispatch: { start, resume },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'codex', args: [] }),
        verifyLaunch,
        readTranscript: vi.fn().mockResolvedValue(null),
        currentLaunchId: () => state.launch,
        inputEpoch,
        isIdle: () => true,
        write,
        isChatTerminal: () => surface === 'chat',
        isChatLive: () => state.isChatLive,
        botHandovers: botHandoverAccess(database),
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const botAuthority = {
        principal: {
            kind: 'agent' as const,
            id: 'bot',
            endpointId: 'bot',
            generation: 1,
            projectIds: [botProject.id],
        },
        callerTerminalId: bot.terminal!.id,
    };
    const { outcomes } = await handovers.handOver({ sessionIds: [session.id] });
    const [handover] = database.getAppState('botHandovers')!;
    expect(outcomes[0].outcome).toBe('accepted');
    const request = {
        projectId: project.id,
        sessionId: session.id,
        prompt: 'Synthetic follow-up task',
        continueFromHandover: handover.id,
    };
    return {
        botAuthority,
        database,
        handover,
        handovers,
        inputEpoch,
        request,
        resume,
        service,
        start,
        state,
        terminal,
        verifyLaunch,
        write,
    };
}

/**
 * The user's message or keystroke as the Server records it: the input epoch advances and the hand-over is taken back.
 */
function userInput(f: Awaited<ReturnType<typeof fixture>>): void {
    f.state.epoch += 1;
    f.handovers.observeInput(f.terminal.id);
}

/**
 * Caxri Bot's first task in a handed-over Session continues the Session's own Agent conversation instead of starting a
 * fresh Agent next to it.
 */
describe('Delegation continuing a Caxri Bot hand-over', () => {
    it('resumes the exact conversation in its Terminal and links the hand-over task', async () => {
        const f = await fixture();
        const id = randomUUID();

        const receipt = await f.service.create(id, f.botAuthority, f.request);

        expect(receipt).toMatchObject({ terminalId: f.terminal.id, status: 'launching' });
        expect(f.start).not.toHaveBeenCalled();
        expect(f.resume).toHaveBeenCalledOnce();
        const call = f.resume.mock.calls[0];
        const target = call[2];
        const options = call[3];
        expect(target).toMatchObject({
            terminalId: f.terminal.id,
            providerSessionId: conversationId,
        });
        expect(options!.replaceLaunchId).toBe('user-launch');
        const [handover] = f.database.getAppState('botHandovers')!;
        expect(handover.firstDelegationId).toBe(id);
        expect(f.database.botTasks.get(handover.taskId!)).toMatchObject({
            delegationId: id,
            status: 'dispatched',
        });
        // A second root task in the same conversation is refused; Caxri Bot follows up the first one instead.
        await expect(f.service.create(randomUUID(), f.botAuthority, f.request)).rejects.toThrow(
            `follow up delegation ${id}`,
        );
    });

    it('refuses a caller other than Caxri Bot', async () => {
        const f = await fixture();
        const owner = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;

        await expect(f.service.create(randomUUID(), owner, f.request)).rejects.toMatchObject({
            code: 'FORBIDDEN',
        });
        expect(f.resume).not.toHaveBeenCalled();
    });

    it('refuses while the Agent is still in a turn, before any task exists', async () => {
        const f = await fixture();
        const id = randomUUID();
        f.database.updateAgentProcessState(f.terminal.id, 'running');
        const getSession = f.database.getSession.bind(f.database);
        vi.spyOn(f.database, 'getSession').mockImplementation((id) => {
            const current = getSession(id);
            return current && { ...current, lastActivityState: 'running' };
        });

        await expect(f.service.create(id, f.botAuthority, f.request)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(f.database.agentDelegations.get(id)).toBeUndefined();
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBeUndefined();
    });

    it('does not take over the Terminal when the user typed into it while the task was prepared', async () => {
        const f = await fixture();
        f.resume.mockImplementationOnce((_id, _principal, _input, options) => {
            f.state.epoch += 1;
            options!.beforeResume();
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['resume']>
            >);
        });

        const receipt = await f.service.create(randomUUID(), f.botAuthority, f.request);

        expect(receipt).toMatchObject({ status: 'failed', failure: 'launch_failed' });
    });

    it('records a live Chat as continued by its next message instead of restarting it', async () => {
        const f = await fixture('chat');
        const id = randomUUID();

        const receipt = await f.service.create(id, f.botAuthority, f.request);

        expect(receipt).toMatchObject({ terminalId: f.terminal.id, status: 'submitting' });
        expect(f.resume).not.toHaveBeenCalled();
        expect(f.write).toHaveBeenCalledOnce();
        const [terminalId, launchId, data] = f.write.mock.calls[0];
        expect([terminalId, launchId]).toEqual([f.terminal.id, 'user-launch']);
        // The task pointer travels as one bracketed paste, which the Chat takes as one message.
        expect(data.startsWith('\u{1B}[200~') && data.endsWith('\u{1B}[201~\r')).toBe(true);
        expect(f.database.agentDelegations.get(id)).toMatchObject({
            launchId: 'user-launch',
            inputEpoch: 0,
        });
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBe(id);
    });

    it('fails a live Chat continuation the Chat refuses at its send chain', async () => {
        const f = await fixture('chat');
        f.write.mockImplementationOnce((_terminalId, _launchId, _data, onDelivered) => {
            queueMicrotask(() => onDelivered?.(false));
            return true;
        });
        const id = randomUUID();

        await f.service.create(id, f.botAuthority, f.request);

        await vi.waitFor(() =>
            expect(f.database.agentDelegations.get(id)?.receipt).toMatchObject({
                status: 'failed',
                failure: 'target_changed',
            }),
        );
    });

    it('resumes a stopped Chat on its conversation through dispatch', async () => {
        const f = await fixture('chat');
        f.state.launch = undefined;
        f.state.isChatLive = false;

        const receipt = await f.service.create(randomUUID(), f.botAuthority, f.request);

        expect(receipt).toMatchObject({ terminalId: f.terminal.id, status: 'launching' });
        expect(f.write).not.toHaveBeenCalled();
        expect(f.resume).toHaveBeenCalledOnce();
        const { 2: target, 3: options } = f.resume.mock.calls[0];
        expect(target).toMatchObject({
            terminalId: f.terminal.id,
            providerSessionId: conversationId,
        });
        expect(options!.replaceLaunchId).toBeUndefined();
    });

    it('refuses a Chat that is still in a turn, before any task exists', async () => {
        const f = await fixture('chat');
        const id = randomUUID();
        f.database.updateAgentProcessState(f.terminal.id, 'running');
        const getSession = f.database.getSession.bind(f.database);
        vi.spyOn(f.database, 'getSession').mockImplementation((sessionId) => {
            const current = getSession(sessionId);
            return current && { ...current, lastActivityState: 'running' };
        });

        await expect(f.service.create(id, f.botAuthority, f.request)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(f.database.agentDelegations.get(id)).toBeUndefined();
        expect(f.write).not.toHaveBeenCalled();
    });

    it('does not message a live Chat the user wrote to while the task was prepared', async () => {
        const f = await fixture('chat');
        // The first read is the capture before the task file is written; the user's message lands meanwhile.
        f.inputEpoch.mockReturnValueOnce(0).mockReturnValue(1);

        const receipt = await f.service.create(randomUUID(), f.botAuthority, f.request);

        expect(receipt).toMatchObject({ status: 'failed', failure: 'human_input' });
        expect(f.write).not.toHaveBeenCalled();
    });

    it.each(['chat', 'pty'] as const)(
        'refuses a %s hand-over the user took back while the launch was verified, before any task exists',
        async (surface) => {
            const f = await fixture(surface);
            f.verifyLaunch.mockImplementationOnce(() => {
                userInput(f);
                return Promise.resolve();
            });
            const id = randomUUID();

            await expect(f.service.create(id, f.botAuthority, f.request)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            expect(f.database.agentDelegations.get(id)).toBeUndefined();
            expect(f.write).not.toHaveBeenCalled();
            expect(f.resume).not.toHaveBeenCalled();
        },
    );

    it('refuses a Chat that is starting or stopping with a retryable conflict, before any task exists', async () => {
        const f = await fixture('chat');
        f.state.launch = undefined;
        const id = randomUUID();

        await expect(f.service.create(id, f.botAuthority, f.request)).rejects.toMatchObject({
            code: 'CONFLICT',
            message: expect.stringContaining('starting or stopping') as unknown,
        });
        expect(f.database.agentDelegations.get(id)).toBeUndefined();
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBeUndefined();
        expect(f.resume).not.toHaveBeenCalled();
    });

    it('releases the hand-over when dispatch refuses the resume before recording it', async () => {
        const f = await fixture('chat');
        f.state.launch = undefined;
        f.state.isChatLive = false;
        f.resume.mockRejectedValueOnce(new Error('Synthetic dispatch refusal'));
        const id = randomUUID();

        const receipt = await f.service.create(id, f.botAuthority, f.request);

        expect(receipt).toMatchObject({ status: 'failed', failure: 'launch_failed' });
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBeUndefined();
        // Caxri Bot's retry continues the same hand-over.
        const retryId = randomUUID();
        await expect(f.service.create(retryId, f.botAuthority, f.request)).resolves.toMatchObject({
            status: 'launching',
        });
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBe(retryId);
    });

    it('refuses a Grok Build Chat target recorded before such Chats became ownership-only', async () => {
        const f = await fixture('chat');
        f.database.rebindAgentSession(f.terminal.id, 'grok', conversationId);
        f.database.setAppState(
            'botHandovers',
            f.database.getAppState('botHandovers')!.map((handover) => ({
                ...handover,
                target: { ...handover.target!, provider: 'grok' as const },
            })),
        );
        const id = randomUUID();

        await expect(f.service.create(id, f.botAuthority, f.request)).rejects.toMatchObject({
            code: 'CONFLICT',
            message: expect.stringContaining('cannot carry a Caxri Bot task') as unknown,
        });
        expect(f.database.agentDelegations.get(id)).toBeUndefined();
        expect(f.database.getAppState('botHandovers')![0].firstDelegationId).toBeUndefined();
    });
});
