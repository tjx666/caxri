import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { commanderHandoverAccess, CommanderHandoverService } from '../../commander';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

const conversationId = '019e676d-8740-7bb2-8bcb-f189c8260607';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-handover-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const commanderRoot = join(directory, 'commander');
    const workRoot = join(directory, 'work');
    await mkdir(commanderRoot);
    await mkdir(workRoot);
    const commanderProject = database.createProject(commanderRoot);
    const commander = database.createSession(commanderProject.id, 'codex');
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commander.session.id,
        terminalId: commander.terminal!.id,
        sessionIds: [],
    });
    const project = database.createProject(workRoot);
    const { session, terminal } = database.createSession(project.id, 'codex');
    database.rebindAgentSession(terminal!.id, 'codex', conversationId);
    const handovers = new CommanderHandoverService({
        database,
        notify: vi.fn(),
        resolveProjectRoot: (path) => Promise.resolve(path),
        sendFullStateChange: vi.fn(),
    });
    const state = { launch: 'user-launch', epoch: 0 };
    const start = vi.fn<AgentDispatchService['start']>();
    const resume = vi.fn<AgentDispatchService['resume']>((_id, _principal, _input, options) => {
        options!.beforeResume();
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['resume']>
        >);
    });
    const service = new AgentDelegationService({
        database,
        dispatch: { start, resume },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'codex', args: [] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn().mockResolvedValue(null),
        currentLaunchId: () => state.launch,
        inputEpoch: () => state.epoch,
        isIdle: () => true,
        write: () => true,
        commanderHandovers: commanderHandoverAccess(database),
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderAuthority = {
        principal: {
            kind: 'agent' as const,
            id: 'commander',
            endpointId: 'commander',
            generation: 1,
            projectIds: [commanderProject.id],
        },
        callerTerminalId: commander.terminal!.id,
    };
    const { outcomes } = await handovers.handOver({ sessionIds: [session.id] });
    const [handover] = database.getAppState('commanderHandovers')!;
    expect(outcomes[0].outcome).toBe('accepted');
    const request = {
        projectId: project.id,
        sessionId: session.id,
        prompt: 'Synthetic follow-up task',
        continueFromHandover: handover.id,
    };
    return {
        commanderAuthority,
        database,
        handover,
        request,
        resume,
        service,
        start,
        state,
        terminal: terminal!,
    };
}

/**
 * The Commander's first task in a handed-over Session continues the Session's own Agent conversation instead of
 * starting a fresh Agent next to it.
 */
describe('Delegation continuing a Commander hand-over', () => {
    it('resumes the exact conversation in its Terminal and links the hand-over task', async () => {
        const f = await fixture();
        const id = randomUUID();

        const receipt = await f.service.create(id, f.commanderAuthority, f.request);

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
        const [handover] = f.database.getAppState('commanderHandovers')!;
        expect(handover.firstDelegationId).toBe(id);
        expect(f.database.commanderTasks.get(handover.taskId!)).toMatchObject({
            delegationId: id,
            status: 'dispatched',
        });
        // A second root task in the same conversation is refused; the Commander follows up the first one instead.
        await expect(
            f.service.create(randomUUID(), f.commanderAuthority, f.request),
        ).rejects.toThrow(`follow up delegation ${id}`);
    });

    it('refuses a caller other than the Commander', async () => {
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

        await expect(f.service.create(id, f.commanderAuthority, f.request)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(f.database.agentDelegations.get(id)).toBeUndefined();
        expect(f.database.getAppState('commanderHandovers')![0].firstDelegationId).toBeUndefined();
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

        const receipt = await f.service.create(randomUUID(), f.commanderAuthority, f.request);

        expect(receipt).toMatchObject({ status: 'failed', failure: 'launch_failed' });
    });
});
