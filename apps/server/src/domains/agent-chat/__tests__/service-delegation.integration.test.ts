import { createHash } from 'node:crypto';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { chatDelegationCompletion } from '../../agent-delegation/chat-child';
import { applyDelegationLifecycle } from '../../agent-delegation/lifecycle';
import { didAcceptDelegationChatWrite } from '../../agent-runtime/delegation-chats';
import type { AgentLifecycleSignal } from '../../agents';
import { AgentCoordinator } from '../../agents/coordinator';
import type { StoredAgentDelegation } from '../../db';
import type { ChatDelegationHooks } from '../chat-delegation';
import { ChatDelegationLinks } from '../chat-delegation';
import type { ChatState } from '../chat-states';
import { fixture } from './chat-service-fixture';

/**
 * Paths avoid words the fake providers act on (`task` contains `ask`, which makes them ask a question).
 */
const POINTER =
    'Read the delegated task from "/tmp/job/brief.md" and carry it out. Delegation ID: d-1.';
const FOLLOW_UP =
    'Read the delegated task from "/tmp/job/follow-up-1.md" and carry it out. Delegation ID: d-1.';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function hooks() {
    return {
        bindLaunch: vi.fn<ChatDelegationHooks['bindLaunch']>(),
        retireLaunch: vi.fn<ChatDelegationHooks['retireLaunch']>(),
        humanInput: vi.fn<ChatDelegationHooks['humanInput']>(),
    };
}

describe('AgentChatService as a delegated child', () => {
    it('starts a Codex child with its frozen launch, takes the pointer as its first turn, and reads the answer', async () => {
        const delegation = hooks();
        const { service, signals, spawnProcess, terminal, until } = await fixture({ delegation });
        service.delegation.prepareStart(terminal.id, {
            launch: { ...defaultAgentProviderSettings.codex.launch, args: ['-c', 'frozen=1'] },
            delegationId: 'd-1',
        });

        await service.start(terminal.id);
        const launchId = service.delegation.liveLaunchId(terminal.id);
        expect(launchId).toBeDefined();
        expect(delegation.bindLaunch).toHaveBeenCalledWith(terminal.id, launchId, 'd-1');
        expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['frozen=1']));

        await service.send(terminal.id, { text: POINTER }, 'queue', 'delegation');
        const snapshot = await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        expect(snapshot.items[0]).toMatchObject({ type: 'userMessage', text: POINTER });
        const started = signals.find((signal) => signal.phase === 'turnStarted');
        expect(started).toMatchObject({ launchId, agentPromptDigest: digest(POINTER) });

        const turnId = started?.agentTurnId ?? '';
        const turn = service.delegation.turnAnswer(terminal.id, turnId);
        expect(chatDelegationCompletion({} as StoredAgentDelegation, turn)).toEqual({
            kind: 'answer',
            text: `Hello from fake Codex. You said: ${POINTER}`,
            messageId: snapshot.items.at(-1)?.id,
        });

        // A follow-up arrives as the PTY bracketed paste and becomes the next turn, with its own digest.
        const delivered = vi.fn<(wasAccepted: boolean) => void>();
        expect(
            didAcceptDelegationChatWrite(
                service,
                terminal.id,
                launchId ?? '',
                `\u{1B}[200~${FOLLOW_UP}\u{1B}[201~\r`,
                delivered,
            ),
        ).toBe(true);
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(true));
        await until((current) => current.turns.length === 2 && !current.activeTurnId);
        expect(signals.findLast((signal) => signal.phase === 'turnStarted')).toMatchObject({
            agentPromptDigest: digest(FOLLOW_UP),
        });
        expect(didAcceptDelegationChatWrite(service, terminal.id, 'other-launch', '\u{1B}')).toBe(
            false,
        );
        expect(delegation.humanInput).not.toHaveBeenCalled();
    });

    it('opens a Claude Code child on the conversation id the task was admitted with and digests its answer', async () => {
        const delegation = hooks();
        const { database, service, signals, terminal, until } = await fixture({
            provider: 'claude',
            delegation,
        });
        const sessionId = '5f0c9a52-8a8e-4f63-9d64-3f1d2e7b6a10';
        service.delegation.prepareStart(terminal.id, {
            launch: { ...defaultAgentProviderSettings.claude.launch, args: [] },
            delegationId: 'd-1',
            agentSessionId: sessionId,
        });

        await service.start(terminal.id);
        await service.send(terminal.id, { text: POINTER }, 'queue', 'delegation');
        const snapshot = await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(sessionId);
        const answer = snapshot.items.findLast((item) => item.type === 'agentMessage');
        const finished = signals.find((signal) => signal.phase === 'turnFinished');
        expect(signals.find((signal) => signal.phase === 'turnStarted')).toMatchObject({
            agentSessionId: sessionId,
            agentPromptDigest: digest(POINTER),
        });
        expect(finished).toMatchObject({
            agentResponseDigest: digest(answer?.type === 'agentMessage' ? answer.text : ''),
        });
        const turn = service.delegation.turnAnswer(terminal.id, finished?.agentTurnId ?? '');
        expect(
            chatDelegationCompletion(
                { responseDigest: finished?.agentResponseDigest } as StoredAgentDelegation,
                turn,
            ),
        ).toMatchObject({ kind: 'answer', messageId: answer?.id });

        // The next start of the same Chat keeps the frozen launch but not the one-shot task binding.
        await service.restart(terminal.id);
        expect(delegation.bindLaunch).toHaveBeenLastCalledWith(
            terminal.id,
            service.delegation.liveLaunchId(terminal.id),
            undefined,
        );
    });

    it('completes a Claude Code child whose turn continues on its own after background work', async () => {
        const holder: { coordinator?: AgentCoordinator } = {};
        const applied: AgentLifecycleSignal[] = [];
        const { database, service, terminal, until } = await fixture({
            provider: 'claude',
            delegation: hooks(),
            observeLifecycleSignal: (signal) => holder.coordinator?.observeLifecycleSignal(signal),
        });
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService(),
            () => {},
            { write: vi.fn<StructuredLogger['write']>() } as unknown as StructuredLogger,
            { onLifecycleApplied: (signal) => applied.push(signal) },
        );
        holder.coordinator = coordinator;
        onTestFinished(() => coordinator.close());
        const sessionId = '0b7f3c1e-5d2a-4c8b-9e61-2a4f8d0c7b35';
        service.delegation.prepareStart(terminal.id, {
            launch: { ...defaultAgentProviderSettings.claude.launch, args: [] },
            delegationId: 'd-1',
            agentSessionId: sessionId,
        });
        await service.start(terminal.id);
        const launchId = service.delegation.liveLaunchId(terminal.id)!;
        coordinator.beginTerminalLaunch(terminal.id, launchId);

        // The fake starts a background subagent, ends its turn, and starts a promptless turn once the command finishes.
        const prompt = 'quick background agent';
        await service.send(terminal.id, { text: prompt }, 'queue', 'delegation');
        await until(
            (snapshot) =>
                snapshot.turns.length === 2 &&
                snapshot.turns.every((turn) => turn.status === 'completed') &&
                !snapshot.activeTurnId,
        );
        const woke = applied.findLast((signal) => signal.phase === 'turnStarted');
        expect(woke?.agentPromptDigest).toBeUndefined();
        expect(woke?.agentContinuedTurnId).toBeDefined();

        let record = {
            receipt: {
                delegationId: 'd-1',
                projectId: 'project',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                provider: 'claude',
                status: 'awaiting_ready',
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
            },
            launchId,
            providerSessionId: sessionId,
            promptDigest: digest(prompt),
        } as StoredAgentDelegation;
        for (const signal of applied)
            record = applyDelegationLifecycle(record, signal, 'lifecycle', () => true) ?? record;
        expect(record.receipt).toMatchObject({ status: 'collecting', failure: undefined });
        expect(record.turnId).toBe(woke?.agentTurnId);
        expect(
            chatDelegationCompletion(
                record,
                service.delegation.turnAnswer(terminal.id, record.turnId!),
            ),
        ).toMatchObject({ kind: 'answer', text: 'The background command finished.' });
    });

    it('refuses a follow-up that reaches the Chat after idle suspension began, without starting a provider', async () => {
        const { service, spawnProcess, terminal, until } = await fixture();
        await service.send(terminal.id, { text: POINTER }, 'queue', 'delegation');
        await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        const launchId = service.delegation.liveLaunchId(terminal.id)!;

        // Admitted against the live launch, but queued behind the suspension that stops it.
        const suspended = service.suspendIdle(terminal.id);
        const delivered = vi.fn<(wasAccepted: boolean) => void>();
        expect(
            didAcceptDelegationChatWrite(
                service,
                terminal.id,
                launchId,
                `\u{1B}[200~${FOLLOW_UP}\u{1B}[201~\r`,
                delivered,
            ),
        ).toBe(true);
        await expect(suspended).resolves.toMatchObject({ lastProcessState: 'suspended' });
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(false));
        expect(service.delegation.liveLaunchId(terminal.id)).toBeUndefined();
        expect(service.isLive(terminal.id)).toBe(false);
        expect(spawnProcess).toHaveBeenCalledOnce();
        await expect(
            service.delegation.sendToLaunch(terminal.id, launchId, FOLLOW_UP),
        ).rejects.toThrow('changed before the message reached it');
        expect(didAcceptDelegationChatWrite(service, terminal.id, launchId, '\u{1B}')).toBe(false);
    });

    it('treats every message except delegation input as a takeover of the child', async () => {
        const delegation = hooks();
        const { service, terminal, until } = await fixture({ delegation });
        await service.send(terminal.id, { text: POINTER }, 'queue', 'delegation');
        await until(
            (current) => current.turns.at(-1)?.status === 'completed' && !current.activeTurnId,
        );
        expect(delegation.humanInput).not.toHaveBeenCalled();
        expect(service.delegation.inputEpoch(terminal.id)).toBe(0);

        // What a Git review send, a pull request merge notice, or a bug report delivers.
        await service.send(terminal.id, { text: 'Review comments for the child' });
        expect(delegation.humanInput).toHaveBeenCalledExactlyOnceWith(terminal.id);
        expect(service.delegation.inputEpoch(terminal.id)).toBe(1);
    });
});

describe('ChatDelegationLinks.liveLaunchId', () => {
    it('reports no live launch while idle suspension or a teardown closes it', () => {
        let state = { session: {}, launchId: 'launch' } as ChatState;
        const links = new ChatDelegationLinks({ state: () => state, admit: () => {} });
        expect(links.liveLaunchId('terminal')).toBe('launch');
        state = { ...state, suspending: true };
        expect(links.liveLaunchId('terminal')).toBeUndefined();
        state = { ...state, suspending: undefined, retiring: 'closed' };
        expect(links.liveLaunchId('terminal')).toBeUndefined();
    });
});
