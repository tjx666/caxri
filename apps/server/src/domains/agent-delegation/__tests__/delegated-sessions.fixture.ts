import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseServerOperationResult } from '@caxri/protocol';
import { onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { createBackgroundSession, discardEmptySession } from '../../session';
import type { DelegationChatTurn } from '../chat-child';
import { createDelegationHandlers } from '../handlers';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A Server with one calling Session that delegates into new Sessions whose Agents open as Chats, driven by hand: the
 * test plays the Chat's lifecycle signals and sets the turn the Chat projection would report. A finished task leaves
 * its Chat idle on its launch, so a follow-up or an exact resume of it is admitted.
 */
export async function delegatedFixture(overrides: Partial<AgentDelegationServiceOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegated-sessions-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(directory, 'work'));
    await mkdir(join(directory, 'caller'));
    const project = database.createProject(join(directory, 'work'));
    const callerProject = database.createProject(join(directory, 'caller'));
    const caller = database.createSession(callerProject.id, 'codex');
    const authority = {
        principal: {
            kind: 'agent' as const,
            id: 'agent',
            endpointId: 'agent',
            generation: 1,
            projectIds: [callerProject.id, project.id],
        },
        callerTerminalId: caller.terminal!.id,
    };
    const state = {
        clock: 1000,
        launchId: undefined as string | undefined,
        step: undefined as string | undefined,
    };
    let turn: DelegationChatTurn = { status: 'running' };
    const dispatchStart = vi.fn<AgentDispatchService['start']>(
        (_id, _principal, input, options) => {
            options?.prepared(database.createTerminal(input.sessionId, 'claude'));
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['start']>
            >);
        },
    );
    const dispatchResume = vi.fn<AgentDispatchService['resume']>(
        (_id, _principal, _input, options) => {
            options!.beforeResume();
            return Promise.resolve({ status: 'running' } as Awaited<
                ReturnType<AgentDispatchService['resume']>
            >);
        },
    );
    const service = new AgentDelegationService({
        database,
        dispatch: { start: dispatchStart, resume: dispatchResume },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: ['--model', 'sonnet'] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn().mockResolvedValue(null),
        opensAgentsInChat: () => true,
        isChatTerminal: () => true,
        readChatTurn: () => turn,
        chatStep: () => state.step,
        currentLaunchId: () => state.launchId,
        inputEpoch: () => 0,
        isIdle: () => true,
        write: () => true,
        now: () => state.clock,
        newSessions: {
            create: (projectId, title, _isBot, createdBySessionId, createdByRelation) =>
                createBackgroundSession(
                    database,
                    projectId,
                    title,
                    createdBySessionId,
                    createdByRelation,
                ),
            discard: (sessionId) => discardEmptySession(database, sessionId),
        },
        ...overrides,
    });
    onTestFinished(() => service.close());
    const request = {
        projectId: project.id,
        provider: 'claude' as const,
        prompt: 'Synthetic private task',
        newSession: true as const,
        title: 'Check the retry design',
    };

    /**
     * Delegates a task into a new Session, advancing the clock so each task has its own creation time.
     */
    const delegate = async (flags: { consult?: true; handoff?: true } = {}) => {
        state.clock += 1000;
        const id = randomUUID();
        const receipt = await service.create(id, authority, { ...request, ...flags });
        return { id, receipt, terminalId: receipt.terminalId! };
    };
    let launches = 0;
    /**
     * Binds the delegated Chat's launch and starts its turn; returns the signal base later phases extend.
     */
    const start = (task: { id: string; terminalId: string }) => {
        launches += 1;
        const launchId = `launch-${launches}`;
        state.launchId = launchId;
        service.bindChatLaunch(task.terminalId, launchId, task.id);
        const stored = database.agentDelegations.get(task.id)!;
        const signal = {
            terminalId: task.terminalId,
            launchId,
            provider: 'claude' as const,
            agentSessionId: stored.providerSessionId,
            agentTurnId: `turn-${launches}`,
        };
        service.observe({
            ...signal,
            phase: 'turnStarted',
            agentPromptDigest: stored.promptDigest,
        });
        return signal;
    };
    const finish = async (task: { id: string; terminalId: string }, answer: string) => {
        const signal = start(task);
        state.clock += 1000;
        service.observe({
            ...signal,
            phase: 'turnFinished',
            agentResponseDigest: digest(answer),
        });
        turn = {
            status: 'finished',
            outcome: 'completed',
            answer: { id: `answer-${task.id}`, text: answer },
            isTruncated: false,
        };
        return service.result(task.id, authority);
    };
    /**
     * `agent.delegation.sessions` through the handler the Server forwards it to, then through the method's result
     * schema as a Client receives it, so a field the contract does not carry or bound fails the test.
     */
    const sessions = async (createdBySessionIds: string[]) =>
        parseServerOperationResult(
            'agent.delegation.sessions',
            await createDelegationHandlers(service, database)['agent.delegation.sessions']({
                createdBySessionIds,
            }),
        ).sessions;
    /**
     * `agent.delegation.statuses` through the handler, then through the method's result schema.
     */
    const statuses = async (delegationIds: string[]) =>
        parseServerOperationResult(
            'agent.delegation.statuses',
            await createDelegationHandlers(service, database)['agent.delegation.statuses']({
                delegationIds,
            }),
        ).statuses;
    return {
        authority,
        callerSessionId: caller.session.id,
        sessions,
        database,
        delegate,
        directory,
        dispatchResume,
        dispatchStart,
        finish,
        project,
        request,
        service,
        start,
        state,
        statuses,
    };
}
