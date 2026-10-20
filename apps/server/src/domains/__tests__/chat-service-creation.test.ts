import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDelegationService } from '../agent-delegation';
import { createAgentChatService } from '../chat-service-creation';
import type { CommanderTerminalHooks } from '../commander';
import { CaxriDatabase } from '../db';

type ChatServiceInput = Parameters<typeof createAgentChatService>[0];

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
    const chatInput = vi.fn<CommanderTerminalHooks['chatInput']>();
    const interruptTerminal = vi.fn<AgentDelegationService['interruptTerminal']>();
    const service = createAgentChatService({
        agentRuntime: { dispatchState: { observe: vi.fn() } } as never,
        commanderHooks: {
            chatInput,
            chatReady: vi.fn<CommanderTerminalHooks['chatReady']>(),
            launchArguments: vi.fn<CommanderTerminalHooks['launchArguments']>(() => []),
        },
        configuration: {} as ChatServiceInput['configuration'],
        database,
        delegationState: { service: { interruptTerminal } as unknown as AgentDelegationService },
        dependencies: {},
        logger: { write: vi.fn() } as never,
        send: vi.fn(),
    });
    return { chatInput, interruptTerminal, service };
}

describe('createAgentChatService', () => {
    it('takes a handed-over Session back on human Chat input, as typing into a PTY Agent does', async () => {
        const { chatInput, interruptTerminal, service } = await compose();

        // What `agentChat.send`, `runCommand`, `rewind`, `interrupt`, and `sendQueuedNow` record from any Client.
        service.delegation.observeHumanInput('chat-terminal');

        expect(chatInput).toHaveBeenCalledExactlyOnceWith('chat-terminal');
        expect(interruptTerminal).toHaveBeenCalledExactlyOnceWith('chat-terminal', true);
    });
});
