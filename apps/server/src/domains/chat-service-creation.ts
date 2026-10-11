import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { AgentChatService } from './agent-chat';
import type { createAgentRuntime } from './agent-runtime';
import { commanderChatEndpoint } from './commander';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';

/**
 * Composes the Chat service with the domain root's launch settings and, when Agent Endpoints exist, the Commander
 * Endpoint so a Chat Commander keeps its `commander` role.
 */
export function createAgentChatService({
    agentRuntime,
    configuration,
    database,
    dependencies,
    logger,
    send,
}: {
    agentRuntime: Pick<
        Awaited<ReturnType<typeof createAgentRuntime>>,
        'agentEnvironment' | 'agentLaunchSettings' | 'coordinator' | 'observeChatLifecycleSignal'
    >;
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
        launchSettings: (provider) =>
            (dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings)(provider),
        resolveExecutable: dependencies.terminal?.resolveExecutable,
        coordinator,
        observeLifecycleSignal: agentRuntime.observeChatLifecycleSignal,
        clientVersion: process.env.CAXRI_APP_VERSION ?? '0.0.0',
        ...(dependencies.agentEndpoints && {
            endpoint: commanderChatEndpoint({
                database,
                endpoints: dependencies.agentEndpoints,
                providerSettings: (provider) =>
                    configuration.getSettings().value['agents.providers'][provider],
            }),
        }),
    });
}
