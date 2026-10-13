import { randomUUID } from 'node:crypto';

import { logEventCatalog } from '@caxri/system';

import type { AgentRunAutonomy } from '../agents';
import { AGENT_SESSION_DISCOVERY_CONTEXT } from '../agents';
import { agentChatDrivers } from './chat-drivers';
import type { ChatExitHost } from './chat-exit';
import { abandonChatStart, handleChatExit } from './chat-exit';
import {
    chatLifecycleHost,
    chatStartFailure,
    didPersistChatStartFailure,
    prepareChatLaunch,
    readChatTranscript,
} from './chat-launch';
import { chatReportedStateHost } from './chat-permission-switch';
import type { AgentChatProviderSession } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { chatSessionLogCallbacks } from './chat-session-logs';
import type { ChatState, ChatTerminal } from './chat-states';

/**
 * What starting a Chat's provider process needs from the service that owns it.
 */
export interface ChatStartHost extends ChatExitHost {
    agentRunAutonomy: AgentRunAutonomy;
    isShuttingDown: () => boolean;
}

/**
 * Launches the provider process for one Chat state and publishes its session as soon as it spawns. A start superseded
 * by a newer launch, or a Chat closed, deleted, detached, or archived while preparing, closes what it opened; a failure
 * is recorded in the projection, where every Client sees it.
 */
export async function startChat(
    host: ChatStartHost,
    terminal: ChatTerminal,
    state: ChatState,
    shouldKeepAgentAutonomy: boolean,
): Promise<void> {
    const { options, states, endpoint, agentRunAutonomy } = host;
    const { database, logger } = options;
    const terminalId = terminal.id;
    const { provider } = terminal;
    const launchId = randomUUID();
    const startedAt = Date.now();
    state.launchId = launchId;
    states.setStatus(terminalId, 'starting');
    database.updateTerminalState(terminalId, 'starting');
    database.updateAgentProcessState(terminalId, 'starting');
    states.publish(terminalId);
    options.coordinator.beginTerminalLaunch(terminalId, launchId);
    const isCurrent = () => state.launchId === launchId && states.get(terminalId) === state;
    let session: AgentChatProviderSession | undefined;
    try {
        const driver = agentChatDrivers[provider];
        if (!driver) throw new AgentChatStartError('spawn_failed');
        const launch = agentRunAutonomy.launch(
            terminalId,
            provider,
            options.launchSettings(provider, terminal),
            shouldKeepAgentAutonomy,
        );
        const prepared = await prepareChatLaunch(options, provider, launch, terminal.cwd);
        const { cwd, executable, isRealAgentE2E } = prepared;
        const environment = await endpoint.environment(terminal, launchId, prepared.environment);
        // Preparing awaited; the Chat may have been closed, deleted, detached, or archived meanwhile.
        if (!states.isAdmitted(terminalId, state)) {
            abandonChatStart(host, host.isShuttingDown(), {
                terminalId,
                state,
                launchId,
                startedAt,
            });
            return;
        }
        session = driver.create({
            terminalId,
            cwd,
            executable,
            environment,
            launch,
            isRealAgentE2E,
            permission: database.getChatPermission(terminalId) ?? { planMode: false },
            agentSessionId: database.getTerminal(terminalId)?.agentSessionId,
            ...(state.resumeAt !== undefined && { resumeAt: state.resumeAt }),
            clientVersion: options.clientVersion,
            ...(environment.CAXRI_CLI &&
                database.agentCommanderRows()?.terminalId !== terminalId && {
                    instructions: AGENT_SESSION_DISCOVERY_CONTEXT,
                }),
            spawnProcess: options.spawnProcess,
            turnRequestTimeoutMs: options.turnRequestTimeoutMs,
            read: () => state.projection.snapshot,
            apply: (operations) => {
                if (isCurrent()) states.apply(terminalId, operations);
            },
            applyTask: (taskId, operations) => {
                if (isCurrent()) state.projection.applyTask(taskId, operations);
            },
            readTask: (taskId) => state.projection.tasks.get(taskId),
            ...chatLifecycleHost(options, {
                launchId,
                provider,
                terminalId,
                isCurrent,
                onEvent: (event) => {
                    // The first new turn writes past the resume point, so a later start resumes the newest record again.
                    if (event.phase === 'turnStarted') state.resumeAt = undefined;
                },
            }),
            ...chatReportedStateHost(database, {
                terminalId,
                provider,
                isCurrent,
                onRebound: () => states.publish(terminalId),
            }),
            ...chatSessionLogCallbacks(options, terminalId),
            onExit: (exit) => handleChatExit(host, terminalId, provider, state, launchId, exit),
            readTranscript: () => readChatTranscript(options, terminalId),
        });
        state.session = session;
        const mode = await session.start();
        if (!isCurrent()) {
            await session.close();
            return;
        }
        await endpoint.activate(terminalId);
        states.setStatus(terminalId, 'ready');
        database.updateTerminalState(terminalId, 'running');
        database.updateAgentProcessState(terminalId, 'running');
        states.publish(terminalId);
        if (database.getTerminal(terminalId)?.agentSessionId)
            options.coordinator.probeTerminal(terminalId);
        logger.write('info', logEventCatalog.agentChat.processStarted, {
            fields: { terminalId, outcome: 'ready', mode, durationMs: Date.now() - startedAt },
        });
        options.onReady?.(terminalId);
    } catch (error) {
        if (state.session === session) state.session = undefined;
        await session?.close();
        if (isCurrent()) endpoint.retire(terminalId);
        const failure = chatStartFailure(options, terminal, error, startedAt);
        if (isCurrent() && !host.isShuttingDown()) {
            states.setStatus(terminalId, 'failed', failure);
            if (didPersistChatStartFailure(options, terminalId, failure))
                states.publish(terminalId);
        }
    }
}
