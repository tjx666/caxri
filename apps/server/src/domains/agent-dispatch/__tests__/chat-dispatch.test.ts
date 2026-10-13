import { join } from 'node:path';

import type { AgentEndpointRef } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import type { TerminalManager } from '../../terminal';
import { createAgentCommandHandlers } from '../handlers';
import type { AgentDispatchService } from '../service';
import {
    closeDispatchFixtures,
    createService,
    fakeChats,
    fakeTerminals,
    openDatabase,
    PRINCIPAL,
    temporaryDirectories,
} from './dispatch-service.fixture';

const ENDPOINT: AgentEndpointRef = { endpointId: 'endpoint-1', generation: 1, hostId: 'host-1' };

afterEach(async () => {
    await closeDispatchFixtures();
});

/**
 * A stopped Codex Chat bound to an Agent Session, with dispatch wired to a stub Chat service whose stops reach the
 * receipts the way `AgentChatServiceOptions.onAgentStateChanged` does.
 */
async function stoppedChat(endpoints?: AgentEndpointLifecycle) {
    const database = await openDatabase();
    const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
    const { session } = database.createSession(project.id, null);
    const terminal = database.createTerminal(session.id, 'codex', undefined, 'chat');
    database.rebindAgentSession(terminal.id, 'codex', 'thread-1');
    database.updateTerminalState(terminal.id, 'stopped');
    database.updateAgentProcessState(terminal.id, 'stopped');
    const relay: { service?: AgentDispatchService } = {};
    const chats = fakeChats(database, (terminalId) =>
        relay.service?.observeTerminalState(terminalId, 'stopped'),
    );
    const terminals = fakeTerminals(database);
    const service = createService(
        database,
        terminals,
        endpoints,
        undefined,
        undefined,
        undefined,
        chats,
    );
    relay.service = service;
    const target = {
        projectId: project.id,
        sessionId: session.id,
        terminalId: terminal.id,
        providerSessionId: 'thread-1',
    };
    return { chats, database, service, target, terminal, terminals };
}

function chatHandlers(f: Awaited<ReturnType<typeof stoppedChat>>) {
    const observeInterrupt = vi.fn<AgentCoordinator['observeInterrupt']>();
    const write = vi.fn<TerminalManager['write']>(() => true);
    const signalAgentExact = vi.fn<TerminalManager['signalAgentExact']>(() => true);
    const handlers = createAgentCommandHandlers({
        agentChat: f.chats,
        coordinator: { observeInterrupt } as unknown as AgentCoordinator,
        database: f.database,
        dispatch: {} as AgentDispatchService,
        emit: vi.fn(),
        endpoints: {
            controlTarget: () => ({
                launchId: 'launch-1',
                ref: ENDPOINT,
                terminalId: f.terminal.id,
            }),
            isCurrent: () => true,
        } as unknown as AgentEndpointLifecycle,
        mainOwned: () => {
            throw new Error('Unexpected public handler call');
        },
        terminals: { signalAgentExact, write } as unknown as TerminalManager,
    });
    return { handlers, observeInterrupt, signalAgentExact, write };
}

describe('Agent dispatch to a Chat', () => {
    it('delivers terminal.sendInternal to a Chat as one message', async () => {
        const f = await stoppedChat();
        const { handlers, write } = chatHandlers(f);

        await expect(
            handlers['terminal.sendInternal']({
                enter: false,
                terminalId: f.terminal.id,
                text: 'check the build',
            }),
        ).resolves.toEqual({
            accepted: true,
            byteLength: 15,
            enter: false,
            terminalId: f.terminal.id,
        });
        expect(f.chats.send).toHaveBeenCalledExactlyOnceWith(f.terminal.id, {
            text: 'check the build',
        });
        expect(write).not.toHaveBeenCalled();
    });

    it('refuses an attention reply to a Chat before consuming the attention', async () => {
        const f = await stoppedChat();
        const consume = vi.spyOn(f.database, 'consumeSessionAttentionReply');
        const { handlers } = chatHandlers(f);

        await expect(
            handlers['terminal.sendInternal']({
                attentionEpoch: 3,
                enter: true,
                terminalId: f.terminal.id,
                text: 'yes',
            }),
        ).rejects.toSatisfy((error) => error instanceof CaxriError && error.code === 'CONFLICT');
        expect(f.chats.send).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
    });

    it('interrupts a Chat on SIGINT and stops its provider on SIGHUP', async () => {
        const f = await stoppedChat();
        const { handlers, observeInterrupt, signalAgentExact } = chatHandlers(f);

        await expect(
            handlers['agent.control.interruptInternal']({ endpoint: ENDPOINT }),
        ).resolves.toEqual({ endpoint: ENDPOINT, outcome: 'signaled', terminalId: f.terminal.id });
        expect(f.chats.interrupt).toHaveBeenCalledExactlyOnceWith(f.terminal.id);
        expect(observeInterrupt).toHaveBeenCalledExactlyOnceWith(f.terminal.id, 'launch-1');

        await handlers['agent.control.stopInternal']({ endpoint: ENDPOINT });
        expect(f.chats.stopProvider).toHaveBeenCalledExactlyOnceWith(f.terminal.id);
        expect(observeInterrupt).toHaveBeenCalledOnce();
        expect(signalAgentExact).not.toHaveBeenCalled();
        expect(f.database.getTerminal(f.terminal.id)).toBeDefined();
    });

    it('resumes a stopped Chat, sends the prompt, and settles when the Chat stops', async () => {
        const f = await stoppedChat();
        const beforeResume = vi.fn<() => void>();

        const receipt = await f.service.resume('chat-resume', PRINCIPAL, f.target, {
            launch: { executable: '/fixture/codex', args: [] },
            initialPrompt: 'continue the plan',
            beforeResume,
        });

        expect(receipt).toMatchObject({
            operation: 'resume',
            status: 'running',
            terminalId: f.terminal.id,
            endpoint: { endpointId: `endpoint-${f.terminal.id}` },
        });
        expect(f.chats.restart).toHaveBeenCalledExactlyOnceWith(f.terminal.id);
        expect(f.chats.send).toHaveBeenCalledExactlyOnceWith(f.terminal.id, {
            text: 'continue the plan',
        });
        expect(beforeResume).toHaveBeenCalledOnce();

        await f.chats.stopProvider(f.terminal.id);
        expect(f.service.status('chat-resume', null)).toMatchObject({ status: 'stopped' });
    });

    it('wakes a stopped Chat on its bound Agent Session', async () => {
        const f = await stoppedChat();
        const { projectId, sessionId, terminalId } = f.target;

        await expect(
            f.service.wake('chat-wake', PRINCIPAL, { projectId, sessionId, terminalId }),
        ).resolves.toMatchObject({
            operation: 'wake',
            status: 'running',
        });
        expect(f.chats.restart).toHaveBeenCalledOnce();
        expect(f.chats.send).not.toHaveBeenCalled();
    });

    it('refuses to resume a live Chat before persisting a receipt', async () => {
        const f = await stoppedChat();
        f.chats.live.add(f.terminal.id);

        await expect(f.service.resume('chat-live', PRINCIPAL, f.target)).rejects.toSatisfy(
            (error) => error instanceof CaxriError && error.code === 'CONFLICT',
        );
        expect(f.chats.restart).not.toHaveBeenCalled();
        expect(() => f.service.status('chat-live', null)).toThrow(
            'Agent dispatch receipt was not found',
        );
    });

    it('fails the receipt and stops the Chat when its Agent Endpoint never activates', async () => {
        const f = await stoppedChat({
            endpointForTerminal: () => {},
        } as unknown as AgentEndpointLifecycle);

        await expect(
            f.service.resume('chat-no-endpoint', PRINCIPAL, f.target),
        ).resolves.toMatchObject({
            status: 'failed',
            failure: { code: 'UNAVAILABLE', reason: 'launch_failed' },
        });
        expect(f.chats.stopProvider).toHaveBeenCalledExactlyOnceWith(f.terminal.id);
        expect(f.chats.live.has(f.terminal.id)).toBe(false);
    });
});
