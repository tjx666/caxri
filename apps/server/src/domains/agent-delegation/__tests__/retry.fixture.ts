import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDelegationReceipt } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { createBackgroundSession, discardEmptySession } from '../../session';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

export type Failure = NonNullable<AgentDelegationReceipt['failure']>;

export async function fixture(
    settings: Partial<AgentDelegationServiceOptions> & { hasResume?: boolean } = {},
) {
    const { hasResume = true, ...overrides } = settings;
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-retry-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const workRoot = join(directory, 'work');
    await mkdir(workRoot);
    const project = database.createProject(workRoot);
    const caller = database.createSession(project.id, 'claude');
    const state = {
        generation: 1,
        callerLaunch: 'caller-launch' as string | undefined,
        childLaunch: 'child-launch' as string | undefined,
        epoch: 0,
        callerTurn: 'live-turn' as string | undefined,
    };
    const callerTerminalId = caller.terminal!.id;
    const loggerWrite = vi.fn<StructuredLogger['write']>();
    const receiptChanges = vi.fn<NonNullable<AgentDelegationServiceOptions['onReceiptChanged']>>();
    const write = vi.fn<NonNullable<AgentDelegationServiceOptions['write']>>(() => true);
    const verifyLaunch = vi.fn<AgentDelegationServiceOptions['verifyLaunch']>(() =>
        Promise.resolve(),
    );
    const prepareWorktree = vi.fn();
    const start = vi.fn<AgentDispatchService['start']>((_id, _principal, input, options) => {
        options?.prepared(database.createTerminal(input.sessionId, input.provider));
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const resume = vi.fn<AgentDispatchService['resume']>((_id, _principal, _input, options) => {
        options!.beforeResume();
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['resume']>
        >);
    });
    const service = new AgentDelegationService({
        database,
        dispatch: hasResume ? { start, resume } : { start },
        logger: { write: loggerWrite } as unknown as StructuredLogger,
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: ['--model', 'sonnet'] }),
        verifyLaunch,
        readTranscript: vi.fn().mockResolvedValue(null),
        inputEpoch: () => state.epoch,
        currentLaunchId: (terminalId) =>
            terminalId === callerTerminalId ? state.callerLaunch : state.childLaunch,
        callerEndpoint: (terminalId) =>
            terminalId === callerTerminalId
                ? { endpointId: 'ep1', generation: state.generation }
                : undefined,
        callerTurnId: () => state.callerTurn,
        write,
        onReceiptChanged: receiptChanges,
        newSessions: {
            create: (projectId, title, _isBot, createdBySessionId, createdByRelation, worktree) => {
                const sessionId = createBackgroundSession(
                    database,
                    projectId,
                    title,
                    createdBySessionId,
                    createdByRelation,
                );
                if (worktree)
                    database.selectWorkbenchProject(
                        sessionId,
                        worktree.projectId,
                        worktree.identity,
                    );
                return sessionId;
            },
            prepareWorktree,
            discard: (sessionId) => discardEmptySession(database, sessionId),
        },
        ...overrides,
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const authority = {
        principal: {
            kind: 'agent' as const,
            id: 'agent:ep1',
            endpointId: 'ep1',
            generation: 1,
            projectIds: [project.id],
        },
        callerTerminalId,
    };
    /**
     * A task the caller delegated into a new Session, bound to its launch, then settled as `failure`.
     */
    const failedTask = async (failure: Failure = 'quota_exhausted', prompt = 'Synthetic task') => {
        const id = randomUUID();
        const receipt = await service.create(id, authority, {
            projectId: project.id,
            provider: 'claude',
            prompt,
            newSession: true,
            title: 'Child work',
        });
        const terminal = database.listTerminals(receipt.sessionId)[0];
        service.bindLaunch(terminal.id, 'child-launch');
        const record = database.agentDelegations.get(id)!;
        database.rebindAgentSession(terminal.id, 'claude', record.providerSessionId!);
        database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, status: 'failed', failure },
        });
        return { id, sessionId: receipt.sessionId, terminal };
    };
    const stored = (id: string) => database.agentDelegations.get(id)!;
    return {
        authority,
        callerTerminalId,
        database,
        directory,
        failedTask,
        loggerWrite,
        prepareWorktree,
        project,
        receiptChanges,
        resume,
        service,
        start,
        state,
        stored,
        verifyLaunch,
        write,
    };
}

export const reasonOf = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
    }
    return;
};
