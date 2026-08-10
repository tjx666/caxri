import type { StructuredLogger } from '../../shared/node/logger';
import {
    agentProviderCatalog,
    agentProviderIds,
    type AgentLaunchSettings,
    type AgentProvider,
} from '../../shared/agents';
import type { AgentActivityState, AgentSnapshot, SessionAttentionKind } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import {
    defaultAgentEnvironment,
    processStateToAgentActivity,
    type AgentEnvironment,
    type AgentSnapshotContext,
} from './contract';
import { discoverExecutable, readVersion } from './discovery';
import { agentProviders } from './providers';

function reliableAttentionKind(
    status: AgentActivityState | undefined,
): SessionAttentionKind | undefined {
    return status === 'waiting' || status === 'completed' || status === 'failed'
        ? status
        : undefined;
}

/**
 * A descriptor's `readState` reads only that provider's local on-disk state. An adapter layers
 * executable discovery and version probing on top of a descriptor, so it is the unit that
 * `AgentService` actually snapshots.
 */
export interface AgentAdapter {
    provider: AgentProvider;
    snapshot(context: AgentSnapshotContext): Promise<AgentSnapshot>;
}

/**
 * Single-flight sharing is safe only for identical provider inputs. In particular, a resumed
 * Terminal can retain its Agent session ID while changing process generation; omitting that
 * generation would let the new probe accept a stale snapshot from the previous process.
 */
function snapshotRequestKey(provider: AgentProvider, context: AgentSnapshotContext): string {
    return JSON.stringify([
        provider,
        context.rootPath,
        context.agentSessionId ?? null,
        context.correlationId ?? null,
        [...new Set(context.excludedAgentSessionIds ?? [])].sort(),
        context.processState ?? null,
        context.startedAt ?? null,
    ]);
}

function createCliAdapter(
    provider: AgentProvider,
    environment: AgentEnvironment,
    launchSettings: () => AgentLaunchSettings,
): AgentAdapter {
    return {
        provider,
        async snapshot(context): Promise<AgentSnapshot> {
            const observedAt = Date.now();
            const [executable, localState] = await Promise.all([
                discoverExecutable(provider, launchSettings().executable),
                agentProviders[provider].readState(context, environment),
            ]);
            const version = executable ? await readVersion(provider, executable) : undefined;
            return {
                provider,
                attentionKind: reliableAttentionKind(localState?.status),
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
    launchSettings?: (provider: AgentProvider) => AgentLaunchSettings,
): Record<AgentProvider, AgentAdapter> {
    return Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            createCliAdapter(provider, environment, () =>
                launchSettings
                    ? launchSettings(provider)
                    : { executable: agentProviderCatalog[provider].executableName, args: [] },
            ),
        ]),
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
        return this.requests.run(snapshotRequestKey(provider, context), async () => {
            const startedAt = performance.now();
            const snapshot = await this.adapters[provider].snapshot(context);
            this.logger?.write('info', 'agent.probe', {
                durationMs: performance.now() - startedAt,
                fields: { provider, available: snapshot.available },
            });
            return snapshot;
        });
    }
}
