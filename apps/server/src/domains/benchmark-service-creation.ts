import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { BenchmarkService, createBenchmarkHandlers } from './agent-benchmark';
import type { createAgentRuntime } from './agent-runtime';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';

/**
 * Composes the Benchmark service, and the request handlers over it, with the same provider launch settings, executable
 * resolution, and Agent environment Agent Chat uses, so a Benchmark runs exactly the CLIs the user's Chats run.
 */
export function createBenchmarkService({
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
    dependencies: Pick<DomainDependencies, 'terminal' | 'userDataPath'>;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
}): { service: BenchmarkService; handlers: ReturnType<typeof createBenchmarkHandlers> } {
    const service = new BenchmarkService({
        database,
        logger,
        send,
        userDataPath: dependencies.userDataPath,
        agentEnvironment: agentRuntime.agentEnvironment,
        launchSettings:
            dependencies.terminal?.agentLaunchSettings ?? agentRuntime.agentLaunchSettings,
        resolveExecutable: dependencies.terminal?.resolveExecutable,
        clientVersion: process.env.CAXRI_APP_VERSION ?? '0.0.0',
    });
    return { service, handlers: createBenchmarkHandlers(service) };
}
