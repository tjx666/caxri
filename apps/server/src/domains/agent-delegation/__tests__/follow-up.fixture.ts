import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { expect, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

export const owner = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A Session whose Claude task already completed on launch `launch`, with the live Terminal reads its follow-up or
 * resume is checked against held in `state`.
 */
export async function fixture(submissionTimeoutMs = 1000) {
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
    const receiptChanges = vi.fn<NonNullable<AgentDelegationServiceOptions['onReceiptChanged']>>();
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
        onReceiptChanged: receiptChanges,
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
        receiptChanges,
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
