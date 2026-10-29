import { randomUUID } from 'node:crypto';

import { agentSessionInstructions, CaxriError } from '@caxri/protocol';
import type { ObservationContext, SingleFlight } from '@caxri/system';
import { logEventCatalog, runWithObservationContext } from '@caxri/system';

import type { AgentRunAutonomy } from '../agents';
import { agentProviderStateRoot } from '../agents';
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
import { requireOpenChatSession } from './chat-states';

/**
 * What starting a Chat's provider process needs from the service that owns it.
 */
export interface ChatStartHost extends ChatExitHost {
    agentRunAutonomy: AgentRunAutonomy;
    delegation: ChatDelegationLinks;
    isShuttingDown: () => boolean;
}

/**
 * The observation context of one provider process (an Agent Run). Its stream callbacks inherit the context they were
 * created in, so without this every turn, task, and activity record would carry the request that happened to start the
 * process, often a `session.create` hours earlier. The request's own identities are cleared explicitly, because
 * contexts merge and an omitted key would keep the inherited value.
 */
function agentRunContext(terminal: ChatTerminal, launchId: string): ObservationContext {
    return {
        agentRunId: launchId,
        traceId: launchId,
        requestId: undefined,
        operationId: undefined,
        projectId: undefined,
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
        bootId: undefined,
        clientId: undefined,
        connectionId: undefined,
        serverId: undefined,
    };
}

/**
 * Launches the provider process for one Chat state and publishes its session as soon as it spawns. A start superseded
 * by a newer launch, or a Chat closed, deleted, detached, or archived while preparing, closes what it opened; a failure
 * is recorded in the projection, where every Client sees it.
 */
async function startChat(
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
    state.turnStartRequestId = undefined;
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
        const prepared = await prepareChatLaunch(
            options,
            provider,
            launch,
            agentProviderStateRoot(terminal),
        );
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
        const instructions =
            options.sessionInstructions &&
            environment.CAXRI_CLI &&
            database.caxriBotRows()?.terminalId !== terminalId
                ? agentSessionInstructions(options.sessionInstructions())
                : undefined;
        const logCallbacks = chatSessionLogCallbacks(options, terminalId, state);
        const runContext = agentRunContext(terminal, launchId);
        const created = runWithObservationContext(runContext, () =>
            driver.create({
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
                ...(instructions && { instructions }),
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
            }),
        );
        session = created;
        state.session = created;
        const mode = await runWithObservationContext(runContext, () => created.start());
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
        // Keeps the trace of the request that started it, and names the Agent Run its later records carry.
        logger.write('info', logEventCatalog.agentChat.processStarted, {
            context: { agentRunId: launchId },
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

/**
 * Resolves the open provider session of a Chat state, starting it or joining the start in flight in `starts`.
 */
export async function ensureChatStarted(
    host: ChatStartHost,
    starts: SingleFlight<string, void>,
    terminalId: string,
    state: ChatState,
    shouldKeepAgentAutonomy: boolean,
): Promise<AgentChatProviderSession> {
    const terminal = host.states.admit(terminalId, state);
    if (host.options.isStartFenced?.())
        throw new CaxriError('CONFLICT', 'Airplane Mode is on; exit it to start Agents');
    /**
     * `start()` publishes its session as soon as the process spawns, before the thread exists, so an open session alone
     * does not mean it can take a turn. Join an in-flight start instead of sending into it early.
     */
    if (starts.has(terminalId) || !state.session?.isOpen)
        await starts.run(terminalId, () =>
            startChat(host, terminal, state, shouldKeepAgentAutonomy),
        );
    // A teardown may have begun while the start was in flight; its session is about to close.
    host.states.admit(terminalId, state);
    return requireOpenChatSession(state, terminal.provider);
}
