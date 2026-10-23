import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import {
    agentChatEndpoint,
    AgentChatService,
    chatStateStore,
    reapGroup,
    reapStaleProviderGroups,
} from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import type { createAgentRuntime } from './agent-runtime';
import type { CommanderTerminalHooks } from './commander';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';

/**
 * Composes the Chat service with the domain root's launch settings and, when Agent Endpoints exist, the Commander
 * Endpoint so a Chat Commander keeps its `commander` role.
 */
export function createAgentChatService({
    agentRuntime,
    commanderHooks,
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
        | 'coordinator'
        | 'dispatchState'
        | 'observeChatLifecycleSignal'
    >;
    commanderHooks: Pick<CommanderTerminalHooks, 'chatInput' | 'chatReady' | 'launchArguments'>;
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
    const service = new AgentChatService({
        database,
        logger,
        send,
        agentEnvironment,
        /**
         * A Chat Commander needs the same Codex overrides as a PTY one, notably the raised `project_doc_max_bytes` that
         * keeps its embedded memory from being cut; `codexChatSettings` carries `-c` over as an app-server root
         * option.
         */
        launchSettings: (provider, terminal) => {
            const settings = (dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings)(
                provider,
            );
            const extra = commanderHooks.launchArguments(terminal);
            return extra.length === 0
                ? settings
                : { ...settings, args: [...settings.args, ...extra] };
        },
        onReady: (terminalId) => {
            commanderHooks.chatReady(terminalId);
            if (service.readLeaseAt(terminalId) !== undefined) onObservationLeaseReady();
        },
        delegation: {
            bindLaunch: (terminalId, launchId, delegationId) =>
                delegationState.service?.bindChatLaunch(terminalId, launchId, delegationId),
            retireLaunch: (terminalId, launchId) =>
                delegationState.service?.interruptTerminal(terminalId, false, launchId),
            humanInput: (terminalId) => {
                commanderHooks.chatInput(terminalId);
                delegationState.service?.interruptTerminal(terminalId, true);
            },
        },
        onAgentStateChanged: agentRuntime.dispatchState.observe,
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
