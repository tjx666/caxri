import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { prepareChatLaunch } from './agent-chat';
import type { createAgentRuntime } from './agent-runtime';
import { ClaudeWindowService, createClaudeWindowHandlers, openSdkSession } from './claude-windows';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';

/**
 * Composes the Claude 5-hour window keeper with the same Claude executable, launch settings, and Agent environment a
 * Claude Chat uses, so it checks and starts windows for the account the user's Chats run as. E2E never runs its timer
 * and never starts Claude for a check, since its `claude` is the fake Agent whose launches specs assert.
 */
export function createClaudeWindowService({
    agentRuntime,
    database,
    dependencies,
    logger,
    send,
}: {
    agentRuntime: Pick<
        Awaited<ReturnType<typeof createAgentRuntime>>,
        'agentEnvironment' | 'agentLaunchSettings'
    >;
    database: CaxriDatabase;
    dependencies: Pick<DomainDependencies, 'terminal'>;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
}): { service: ClaudeWindowService; handlers: ReturnType<typeof createClaudeWindowHandlers> } {
    const launchSettings =
        dependencies.terminal?.agentLaunchSettings ?? agentRuntime.agentLaunchSettings;
    const service = new ClaudeWindowService({
        database,
        logger,
        send,
        isTimerEnabled: process.env.CAXRI_E2E !== '1',
        isProbeEnabled: process.env.CAXRI_E2E !== '1',
        openSession: async () => {
            const prepared = await prepareChatLaunch(
                {
                    agentEnvironment: agentRuntime.agentEnvironment,
                    resolveExecutable: dependencies.terminal?.resolveExecutable,
                },
                'claude',
                launchSettings('claude'),
                // The Chat launch guard refuses a working directory reached through a symlink, and macOS's
                // `/var/folders/...` temporary directory is one (`/private/var/...`).
                await realpath(tmpdir()),
            );
            return openSdkSession({
                executable: prepared.executable,
                environment: prepared.environment,
                clientVersion: process.env.CAXRI_APP_VERSION ?? '0.0.0',
            });
        },
    });
    return { service, handlers: createClaudeWindowHandlers(service) };
}
