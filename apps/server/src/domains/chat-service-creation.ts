import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { agentChatEndpoint, AgentChatService } from './agent-chat';
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
    dependencies,
    logger,
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
    commanderHooks: Pick<CommanderTerminalHooks, 'chatReady' | 'launchArguments'>;
    configuration: Pick<ConfigService, 'getSettings'>;
    database: CaxriDatabase;
    dependencies: Pick<DomainDependencies, 'agentEndpoints' | 'terminal'>;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
}): AgentChatService {
    const { agentEnvironment, agentLaunchSettings, coordinator } = agentRuntime;
    return new AgentChatService({
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
        onReady: commanderHooks.chatReady,
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
}
