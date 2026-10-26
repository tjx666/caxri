import { randomUUID } from 'node:crypto';

import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { AgentRunAutonomy } from '../agents';
import { AGENT_SESSION_DISCOVERY_CONTEXT } from '../agents';
import { recordChatTurnMetrics } from '../usage';
import type { ChatDelegationLinks } from './chat-delegation';
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
import { createChatMcpServerWatch } from './chat-mcp-servers';
import { chatReportedStateHost } from './chat-permission-switch';
import type { AgentChatProviderSession } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { chatSessionLogCallbacks } from './chat-session-logs';
import { chatStateStore } from './chat-state-store';
import type { ChatState, ChatTerminal } from './chat-states';

/**
 * What starting a Chat's provider process needs from the service that owns it.
 */
export interface ChatStartHost extends ChatExitHost {
    agentRunAutonomy: AgentRunAutonomy;
    delegation: ChatDelegationLinks;
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
    const { options, states, endpoint, agentRunAutonomy, delegation } = host;
    const { database, logger } = options;
    const terminalId = terminal.id;
    const { provider } = terminal;
    const launchId = randomUUID();
    const startedAt = Date.now();
    // Every provider spawn or resume writes `starting` here, first: a stopped, suspended, or failed Chat takes a slot
    // under the Terminal limits (`TerminalsModel.updateState`), and a refusal must leave the Chat untouched.
    try {
        states.writeProcessState(terminalId, 'starting');
    } catch (error) {
        if (error instanceof CaxriError && error.code === 'CAPACITY')
            logger.write('warn', logEventCatalog.agentChat.processStarted, {
                fields: { terminalId, outcome: 'refused', reason: 'capacity', provider },
            });
        throw error;
    }
    state.launchId = launchId;
    state.suspending = undefined;
    states.setStatus(terminalId, 'starting');
    states.publish(terminalId);
    options.coordinator.beginTerminalLaunch(terminalId, launchId);
    const isCurrent = () => state.launchId === launchId && states.get(terminalId) === state;
    let session: AgentChatProviderSession | undefined;
    const mcpServers = createChatMcpServerWatch({
        read: () => state.projection.snapshot,
        apply: (operations) => {
            if (isCurrent()) states.apply(terminalId, operations);
        },
        lookup: () =>
            session?.readMcpServer && isCurrent()
                ? (name) => session?.readMcpServer?.(name) ?? Promise.resolve(undefined)
                : undefined,
    });
    const delegated = delegation.takeStart(terminalId);
    try {
        const driver = agentChatDrivers[provider];
        if (!driver) throw new AgentChatStartError('spawn_failed');
        const launch = agentRunAutonomy.launch(
            terminalId,
            provider,
            delegation.launchSettings(terminalId) ?? options.launchSettings(provider, terminal),
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
        // Like a PTY launch environment, binds this launch to Agent delegation before anything spawns.
        delegation.bindLaunch(terminalId, launchId, delegated.delegationId);
        // Stored by a rewind, so it survives a Server Core restart before the first new turn.
        const resumeAt = chatStateStore(database).resumeAt(terminalId);
        const logCallbacks = chatSessionLogCallbacks(options, terminalId);
        session = driver.create({
            terminalId,
            cwd,
            executable,
            environment,
            launch,
            isRealAgentE2E,
            permission: database.getChatPermission(terminalId) ?? { planMode: false },
            agentSessionId: database.getTerminal(terminalId)?.agentSessionId,
            ...(delegated.agentSessionId && { newAgentSessionId: delegated.agentSessionId }),
            ...(resumeAt !== undefined && { resumeAt }),
            clientVersion: options.clientVersion,
            ...(environment.CAXRI_CLI &&
                database.agentCommanderRows()?.terminalId !== terminalId && {
                    instructions: AGENT_SESSION_DISCOVERY_CONTEXT,
                }),
            spawnProcess: options.spawnProcess,
            processGroups: { terminalId, ledger: chatStateStore(database).processGroups },
            turnRequestTimeoutMs: options.turnRequestTimeoutMs,
            longRunningShellCommands: options.longRunningShellCommands,
            read: () => state.projection.snapshot,
            apply: (operations) => {
                if (!isCurrent()) return;
                states.apply(terminalId, operations);
                mcpServers.observe(operations);
            },
            applyTask: (taskId, operations) => {
                if (isCurrent()) state.projection.applyTask(taskId, operations);
            },
            readTask: (taskId) => state.projection.tasks.get(taskId),
            observePlanLimits: (reading) => options.usage?.observe(provider, reading),
            ...chatLifecycleHost(options, {
                launchId,
                provider,
                terminalId,
                isCurrent,
                onEvent: (event) => {
                    // The first new turn writes past the resume point, so a later start resumes the newest record again.
                    if (resumeAt !== undefined && event.phase === 'turnStarted')
                        chatStateStore(database).setResumeAt(terminalId, undefined);
                },
            }),
            ...chatReportedStateHost(database, {
                terminalId,
                provider,
                isCurrent,
                onRebound: () => states.publish(terminalId),
            }),
            ...logCallbacks,
            onTurnFinished: (status, durationMs, turnId) => {
                logCallbacks.onTurnFinished(status, durationMs, turnId);
                void recordChatTurnMetrics(
                    {
                        apply: (operations) => states.apply(terminalId, operations),
                        isCurrent,
                        read: () => state.projection.snapshot,
                        readThroughput: async () =>
                            (await options.readThroughput?.(terminalId)) ?? null,
                    },
                    turnId,
                );
            },
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
        states.writeProcessState(terminalId, 'running');
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
