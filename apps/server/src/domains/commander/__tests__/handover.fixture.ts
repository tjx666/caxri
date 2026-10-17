import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import type { CommanderHandoverServiceOptions, DiscoveredConversation } from '../handover';
import { CommanderHandoverService } from '../handover';

export async function fixture(discovered: DiscoveredConversation[] = []) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-handover-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    const repo = join(directory, 'repository');
    await mkdir(join(repo, 'packages', 'web'), { recursive: true });
    const userProject = database.createProject(repo);
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: [],
    });
    /**
     * A user Session whose primary Agent holds a Codex conversation, like one started from the Workbench.
     */
    const agentSession = (conversationId = 'conversation-1') => {
        const { session, terminal } = database.createSession(userProject.id, 'codex');
        database.rebindAgentSession(terminal!.id, 'codex', conversationId);
        return { session, terminal: terminal! };
    };
    /**
     * A user Session whose primary Agent is an Agent Chat, bound to `conversationId` once its provider opened one.
     */
    const chatSession = (provider: 'claude' | 'codex' | 'grok', conversationId?: string) => {
        const { session } = database.createSession(userProject.id, null);
        const terminal = database.createTerminal(session.id, provider, repo, 'chat');
        if (conversationId) database.rebindAgentSession(terminal.id, provider, conversationId);
        return { session, terminal };
    };
    const notify = vi.fn<CommanderHandoverServiceOptions['notify']>();
    const logger = { write: vi.fn<(...arguments_: unknown[]) => void>() };
    const sendFullStateChange = vi.fn<() => void>();
    const resolveProjectRoot = vi.fn((path: string) => Promise.resolve(path));
    const service = new CommanderHandoverService({
        database,
        discoverConversations: (bound) =>
            Promise.resolve(
                discovered.filter((conversation) => !bound.has(conversation.providerSessionId)),
            ),
        logger: logger as never,
        notify,
        now: () => 50_000,
        resolveProjectRoot,
        sendFullStateChange,
    });
    return {
        agentSession,
        chatSession,
        commanderSession,
        database,
        directory,
        logger,
        notify,
        repository: repo,
        resolveProjectRoot,
        sendFullStateChange,
        service,
        userProject,
    };
}
