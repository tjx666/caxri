import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { serverEventSchema } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type * as AgentChatModule from '../agent-chat';
import type { AgentChatService } from '../agent-chat';
import type { AgentDelegationService } from '../agent-delegation';
import type { BotTerminalHooks } from '../bot';
import { createAgentChatService } from '../chat-service-creation';
import { CaxriDatabase } from '../db';

type ChatServiceInput = Parameters<typeof createAgentChatService>[0];
type ChatServiceOptions = ConstructorParameters<typeof AgentChatService>[0];

/**
 * The options the composition hands to the Chat service, captured as the service is constructed. The service stays the
 * real one; the capture lets a test call the `send` the projection uses, which only a provider turn reaches otherwise.
 */
const captured = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock('../agent-chat', async (importOriginal) => {
    const original = await importOriginal<typeof AgentChatModule>();
    return {
        ...original,
        AgentChatService: class extends original.AgentChatService {
            constructor(options: ChatServiceOptions) {
                super(options);
                captured.options = options;
            }
        },
    };
});

/**
 * The Chat service as the domain root composes it, with inert runtime pieces: only its delegation hooks are exercised.
 */
async function compose() {
    // The Chat service reconciles persisted subagent rows when it is built, so it needs a real database.
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-service-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const chatInput = vi.fn<BotTerminalHooks['chatInput']>();
    const interruptTerminal = vi.fn<AgentDelegationService['interruptTerminal']>();
    const observeChatProgress = vi.fn<AgentDelegationService['observeChatProgress']>();
    const send = vi.fn<ChatServiceInput['send']>();
    const service = createAgentChatService({
        agentRuntime: {
            dispatchState: { observe: vi.fn() },
            usageGuards: { subscribe: vi.fn() },
        } as never,
        botHooks: {
            chatInput,
            chatReady: vi.fn<BotTerminalHooks['chatReady']>(),
            launchArguments: vi.fn<BotTerminalHooks['launchArguments']>(() => []),
        },
        configuration: {} as ChatServiceInput['configuration'],
        database,
        delegationState: {
            service: {
                interruptTerminal,
                observeChatProgress,
            } as unknown as AgentDelegationService,
        },
        dependencies: {},
        logger: { write: vi.fn() } as never,
        onObservationLeaseReady: vi.fn(),
        send,
    });
    return {
        chatInput,
        chatSend: (event: ServerEvent) => (captured.options as ChatServiceOptions).send(event),
        interruptTerminal,
        observeChatProgress,
        send,
        service,
    };
}

/**
 * A flushed Chat patch of `terminalId`, as the projection sends it, checked against the event's own schema.
 */
function chatPatch(terminalId: string): ServerEvent {
    return serverEventSchema.parse({
        event: 'agentChat.patch',
        payload: { terminalId, baseRevision: 3, revision: 4, operations: [{ op: 'reset' }] },
    });
}

describe('createAgentChatService', () => {
    it('takes a handed-over Session back on human Chat input, as typing into a PTY Agent does', async () => {
        const { chatInput, interruptTerminal, service } = await compose();

        // What `agentChat.send`, `runCommand`, `rewind`, `interrupt`, and `sendQueuedNow` record from any Client.
        service.delegation.observeHumanInput('chat-terminal');

        expect(chatInput).toHaveBeenCalledExactlyOnceWith('chat-terminal');
        expect(interruptTerminal).toHaveBeenCalledExactlyOnceWith('chat-terminal', true);
    });

    it('reaches Clients and then publishes the progress of the Terminal a Chat patch changed', async () => {
        const { chatSend, observeChatProgress, send } = await compose();
        const patch = chatPatch('chat-terminal');

        chatSend(patch);

        expect(send).toHaveBeenCalledExactlyOnceWith(patch);
        expect(observeChatProgress).toHaveBeenCalledExactlyOnceWith('chat-terminal');
        expect(send.mock.invocationCallOrder[0]).toBeLessThan(
            observeChatProgress.mock.invocationCallOrder[0],
        );
    });

    it('leaves delegation progress alone for any other event', async () => {
        const { chatSend, observeChatProgress, send } = await compose();
        const event = serverEventSchema.parse({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['chat-terminal'] },
        });

        chatSend(event);

        expect(send).toHaveBeenCalledExactlyOnceWith(event);
        expect(observeChatProgress).not.toHaveBeenCalled();
    });
});
