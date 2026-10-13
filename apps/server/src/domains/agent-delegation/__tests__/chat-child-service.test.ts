import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import type { DelegationChatTurn } from '../chat-child';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const owner = { principal: { kind: 'human-cli', id: 'owner' } } as const;

async function fixture(overrides: Partial<AgentDelegationServiceOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-chat-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'claude');
    const start = vi.fn<AgentDispatchService['start']>((_id, _principal, _input, options) => {
        options?.prepared(terminal!);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const resume = vi.fn<AgentDispatchService['resume']>();
    let turn: DelegationChatTurn = { status: 'running' };
    const service = new AgentDelegationService({
        database,
        dispatch: { start, resume },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: ['--model', 'sonnet'] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn<AgentDelegationServiceOptions['readTranscript']>(),
        opensAgentsInChat: () => true,
        isChatTerminal: () => true,
        readChatTurn: () => turn,
        ...overrides,
    });
    onTestFinished(() => service.close());
    const id = randomUUID();
    await service.create(id, owner, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'claude',
        prompt: 'Synthetic private task',
    });
    return {
        database,
        id,
        input: { projectId: project.id, sessionId: session.id, provider: 'claude' as const },
        resume,
        service,
        start,
        terminal: terminal!,
        setTurn: (next: DelegationChatTurn) => {
            turn = next;
        },
    };
}

describe('AgentDelegationService with a Chat child', () => {
    it('opens the child as a Chat, binds its launch, and collects the answer from the Chat', async () => {
        const f = await fixture();
        const options = f.start.mock.lastCall?.[3];
        const stored = f.database.agentDelegations.get(f.id)!;
        const pointer = options?.initialPrompt ?? '';
        expect(options).toMatchObject({ surface: 'chat', delegationId: f.id });
        expect(options?.assignedAgentSessionId).toBe(stored.providerSessionId);
        expect(digest(pointer)).toBe(stored.promptDigest);
        expect(options?.launch.args).not.toContain(pointer);

        f.service.bindChatLaunch(f.terminal.id, 'chat-launch', f.id);
        expect(f.database.agentDelegations.get(f.id)?.launchId).toBe('chat-launch');
        const signal = {
            terminalId: f.terminal.id,
            launchId: 'chat-launch',
            provider: 'claude' as const,
            agentSessionId: stored.providerSessionId,
            agentTurnId: 'turn',
        };
        f.service.observe({ ...signal, phase: 'turnStarted', agentPromptDigest: digest(pointer) });
        expect(f.service.status(f.id, owner).status).toBe('running');
        f.service.observe({
            ...signal,
            phase: 'turnFinished',
            agentResponseDigest: digest('Answer'),
        });
        f.setTurn({
            status: 'finished',
            outcome: 'completed',
            answer: { id: 'item', text: 'Answer' },
            isTruncated: false,
        });
        const result = await f.service.result(f.id, owner);
        expect(result.receipt.status).toBe('completed');
        expect(result.answer?.text).toBe('Answer');
    });

    it('refuses a Chat launch for a task that no longer owns it, and fences on any other launch', async () => {
        const f = await fixture();
        expect(() => f.service.bindChatLaunch(f.terminal.id, 'chat-launch', 'other')).toThrow(
            /no longer owns/u,
        );
        f.service.bindChatLaunch(f.terminal.id, 'chat-launch', f.id);
        f.service.bindChatLaunch(f.terminal.id, 'later-launch');
        expect(f.service.status(f.id, owner)).toMatchObject({
            status: 'interrupted',
            failure: 'target_changed',
        });
    });

    it('treats a person typing into the Chat once its task runs as a takeover', async () => {
        const f = await fixture();
        f.service.bindChatLaunch(f.terminal.id, 'chat-launch', f.id);
        const stored = f.database.agentDelegations.get(f.id)!;
        f.service.observe({
            terminalId: f.terminal.id,
            launchId: 'chat-launch',
            provider: 'claude',
            agentSessionId: stored.providerSessionId,
            agentTurnId: 'turn',
            phase: 'turnStarted',
            agentPromptDigest: stored.promptDigest,
        });
        f.service.interruptTerminal(f.terminal.id, true);
        expect(f.service.status(f.id, owner).status).not.toBe('running');
        expect(f.database.agentDelegations.get(f.id)?.hasHumanIntervention).toBe(true);
    });

    it('refuses to resume a completed child after a non-Client message took the Chat over', async () => {
        const f = await fixture();
        f.service.bindChatLaunch(f.terminal.id, 'chat-launch', f.id);
        const stored = f.database.agentDelegations.get(f.id)!;
        f.database.rebindAgentSession(f.terminal.id, 'claude', stored.providerSessionId!);
        const signal = {
            terminalId: f.terminal.id,
            launchId: 'chat-launch',
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
            agentResponseDigest: digest('Answer'),
        });
        f.setTurn({
            status: 'finished',
            outcome: 'completed',
            answer: { id: 'item', text: 'Answer' },
            isTruncated: false,
        });
        expect((await f.service.result(f.id, owner)).receipt.status).toBe('completed');

        // What `ChatDelegationHooks.humanInput` does when a Git review send reaches the Chat through `send`.
        f.service.interruptTerminal(f.terminal.id, true);
        expect(
            await f.service.create(randomUUID(), owner, {
                ...f.input,
                prompt: 'Synthetic resumed task',
                resumeFrom: f.id,
            }),
        ).toMatchObject({ status: 'failed', failure: 'human_input' });
        expect(f.resume).not.toHaveBeenCalled();
    });
});
