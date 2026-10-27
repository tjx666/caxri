import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatServiceOptions } from './agent-chat';
import {
    agentChatEndpoint,
    AgentChatService,
    chatStateStore,
    ChatUsageContinuation,
    ChatUsageLimitWaits,
    reapStaleProviderGroups,
} from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import type { createAgentRuntime } from './agent-runtime';
import type { BotTerminalHooks } from './bot';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import { reapGroup } from './process-group';
import { discardEmptySession, isAirplaneModeHolding } from './session';

/**
 * Composes the Chat service with the domain root's launch settings and, when Agent Endpoints exist, Caxri Bot Endpoint
 * so a Chat of Caxri Bot keeps its `bot` role.
 */
export function createAgentChatService({
    agentRuntime,
    botHooks,
    configuration,
    database,
    delegationState,
    dependencies,
    logger,
    onObservationLeaseReady,
    send,
}: {
    agentRuntime: Pick<
        Awaited<ReturnType<typeof createAgentRuntime>>,
        | 'agentEnvironment'
        | 'agentLaunchSettings'
        | 'agentThroughput'
        | 'coordinator'
        | 'dispatchState'
        | 'observeChatLifecycleSignal'
        | 'usageGuards'
    >;
    botHooks: Pick<BotTerminalHooks, 'chatInput' | 'chatReady' | 'launchArguments'>;
    configuration: Pick<ConfigService, 'getSettings'>;
    database: CaxriDatabase;
    /**
     * Late-bound: the delegation service is composed after the Chat service.
     */
    delegationState: { service?: AgentDelegationService };
    dependencies: Pick<DomainDependencies, 'agentEndpoints' | 'terminal'>;
    logger: StructuredLogger;
    /**
     * Runs when a provider that a read alone started becomes ready, so the suspension sweep can enforce
     * `MAX_CHAT_OBSERVATION_LEASES` now instead of at its next poll.
     */
    onObservationLeaseReady: () => void;
    send: (event: ServerEvent) => void;
}): AgentChatService {
    const { agentEnvironment, agentLaunchSettings, coordinator } = agentRuntime;
    /**
     * A Chat of Caxri Bot needs the same Codex overrides as a PTY one, notably the raised `project_doc_max_bytes` that
     * keeps its embedded memory from being cut; `codexChatSettings` carries `-c` over as an app-server root option.
     */
    const launchSettings: AgentChatServiceOptions['launchSettings'] = (provider, terminal) => {
        const settings = (dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings)(
            provider,
        );
        const extra = botHooks.launchArguments(terminal);
        return extra.length === 0 ? settings : { ...settings, args: [...settings.args, ...extra] };
    };
    const usage = new ChatUsageContinuation({
        database,
        logger,
        launchSettings,
        resolveExecutable: dependencies.terminal?.resolveExecutable,
        guards: agentRuntime.usageGuards,
        createDelegation: (id, authority, request) => {
            if (!delegationState.service)
                throw new CaxriError('UNAVAILABLE', 'Agent delegation is not ready');
            return delegationState.service.create(id, authority, request);
        },
        discardSession: (sessionId) =>
            discardEmptySession(database, sessionId, () =>
                send({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'session.delete' },
                }),
            ),
    });
    const usageLimitWaits = new ChatUsageLimitWaits({
        database,
        logger,
        settings: () => configuration.getSettings().value,
        isUsageGuarded: (terminalId) => usage.isBlocked(terminalId),
    });
    const service = new AgentChatService({
        database,
        logger,
        send,
        agentEnvironment,
        launchSettings,
        usage,
        usageLimitWaits,
        isStartFenced: () => isAirplaneModeHolding(database.getAppState('airplaneMode')),
        longRunningShellCommands: () =>
            configuration.getSettings().value['agents.longRunningShellCommands'],
        sessionInstructions: () => configuration.getSettings().value['agents.sessionInstructions'],
        onReady: (terminalId) => {
            botHooks.chatReady(terminalId);
            if (service.readLeaseAt(terminalId) !== undefined) onObservationLeaseReady();
        },
        delegation: {
            bindLaunch: (terminalId, launchId, delegationId) =>
                delegationState.service?.bindChatLaunch(terminalId, launchId, delegationId),
            retireLaunch: (terminalId, launchId) =>
                delegationState.service?.interruptTerminal(terminalId, false, launchId),
            humanInput: (terminalId) => {
                usageLimitWaits.cancel(terminalId, 'userInput');
                botHooks.chatInput(terminalId);
                delegationState.service?.interruptTerminal(terminalId, true);
            },
        },
        onAgentStateChanged: agentRuntime.dispatchState.observe,
        readThroughput: (terminalId) => agentRuntime.agentThroughput.read(terminalId),
        resolveExecutable: dependencies.terminal?.resolveExecutable,
        coordinator,
        observeLifecycleSignal: agentRuntime.observeChatLifecycleSignal,
        clientVersion: process.env.CAXRI_APP_VERSION ?? '0.0.0',
        ...(dependencies.agentEndpoints && {
            endpoint: agentChatEndpoint({
                database,
                endpoints: dependencies.agentEndpoints,
                providerSettings: (provider) =>
                    configuration.getSettings().value['agents.providers'][provider],
            }),
        }),
    });
    /**
     * Provider process groups a previous Server Core lifetime left behind when it was killed. The records are read
     * synchronously, before any Chat can start and record a group of this lifetime.
     */
    void reapStaleProviderGroups({
        ledger: () => chatStateStore(database).processGroups,
        logger,
        reapGroup,
    });
    return service;
}
