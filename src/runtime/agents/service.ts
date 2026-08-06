import type { StructuredLogger } from '../../shared/node/logger';
import { agentProviderIds, type AgentProvider } from '../../shared/agents';
import type { AgentSnapshot } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import {
    defaultAgentEnvironment,
    processStateToAgentActivity,
    type AgentEnvironment,
    type AgentSnapshotContext,
} from './contract';
import { discoverExecutable, readVersion } from './discovery';
import { agentProviders } from './providers';

/**
 * A descriptor's `readState` reads only that provider's local on-disk state. An adapter layers
 * executable discovery and version probing on top of a descriptor, so it is the unit that
 * `AgentService` actually snapshots.
 */
export interface AgentAdapter {
    provider: AgentProvider;
    snapshot(context: AgentSnapshotContext): Promise<AgentSnapshot>;
}

function createCliAdapter(provider: AgentProvider, environment: AgentEnvironment): AgentAdapter {
    return {
        provider,
        async snapshot(context): Promise<AgentSnapshot> {
            const observedAt = Date.now();
            const [executable, localState] = await Promise.all([
                discoverExecutable(provider),
                agentProviders[provider].readState(context, environment),
            ]);
            const version = executable ? await readVersion(provider, executable) : undefined;
            return {
                provider,
                status: localState?.status ?? processStateToAgentActivity(context.processState),
                observedAt,
                available: Boolean(executable),
                executable,
                version,
                sessionId: localState?.sessionId,
                title: localState?.title,
                usage: localState?.usage,
            };
        },
    };
}

export function createLocalAgentAdapters(
    environment: AgentEnvironment = defaultAgentEnvironment(),
): Record<AgentProvider, AgentAdapter> {
    return Object.fromEntries(
        agentProviderIds.map((provider) => [provider, createCliAdapter(provider, environment)]),
    ) as Record<AgentProvider, AgentAdapter>;
}

export class AgentService {
    private readonly requests = new SingleFlight<string, AgentSnapshot>();

    constructor(
        private readonly logger?: StructuredLogger,
        private readonly adapters: Record<AgentProvider, AgentAdapter> = createLocalAgentAdapters(),
    ) {}

    snapshot(
        provider: AgentProvider,
        context: AgentSnapshotContext = { rootPath: process.cwd() },
    ): Promise<AgentSnapshot> {
        return this.requests.run(
            `${provider}:${context.rootPath}:${context.agentSessionId ?? context.correlationId ?? ''}`,
            async () => {
                const startedAt = performance.now();
                const snapshot = await this.adapters[provider].snapshot(context);
                this.logger?.write('info', 'agent.probe', {
                    durationMs: performance.now() - startedAt,
                    fields: { provider, available: snapshot.available },
                });
                return snapshot;
            },
        );
    }
}
