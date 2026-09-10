import process from 'node:process';

import type {
    AgentActivityState,
    AgentLaunchSettings,
    AgentProvider,
    AgentSnapshot,
    SessionAttentionKind,
} from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { SingleFlight } from '../single-flight';
import type {
    AgentEnvironment,
    AgentPasteSummaryGenerationContext,
    AgentSessionRenameContext,
    AgentSessionRenameResult,
    AgentSnapshotContext,
} from './contract';
import { defaultAgentEnvironment, processStateToAgentActivity } from './contract';
import { discoverExecutable, readVersion } from './discovery';
import { agentProviders } from './providers';

const attentionKinds: ReadonlySet<AgentActivityState> = new Set(['waiting', 'completed', 'failed']);

function reliableAttentionKind(
    status: AgentActivityState | undefined,
): SessionAttentionKind | undefined {
    return status && attentionKinds.has(status) ? (status as SessionAttentionKind) : undefined;
}

/**
 * A descriptor's `readState` reads only that provider's local on-disk state. An adapter layers executable discovery and
 * version probing on top of a descriptor, so it is the unit that `AgentService` actually snapshots.
 */
export interface AgentAdapter {
    generateTitle?(context: AgentPasteSummaryGenerationContext): Promise<string>;
    provider: AgentProvider;
    renameSession(context: AgentSessionRenameContext): Promise<AgentSessionRenameResult>;
    snapshot(context: AgentSnapshotContext): Promise<AgentSnapshot>;
    summarizePaste?(context: AgentPasteSummaryGenerationContext): Promise<string>;
}

/**
 * Single-flight sharing is safe only for identical provider inputs. In particular, a resumed Terminal can retain its
 * Agent session ID while changing process generation; omitting that generation would let the new probe accept a stale
 * snapshot from the previous process.
 */
function snapshotRequestKey(provider: AgentProvider, context: AgentSnapshotContext): string {
    return JSON.stringify([
        provider,
        context.rootPath,
        context.agentSessionId ?? null,
        context.agentTurnId ?? null,
        context.correlationId ?? null,
        [...new Set(context.excludedAgentSessionIds)].toSorted((a, b) => a.localeCompare(b)),
        context.shellPid ?? null,
        context.processState ?? null,
        context.startedAt ?? null,
    ]);
}

function createCliAdapter(
    provider: AgentProvider,
    environment: AgentEnvironment,
    launchSettings: () => AgentLaunchSettings,
): AgentAdapter {
    const providerDescriptor = agentProviders[provider];
    const pasteSummary = providerDescriptor.pasteSummary;
    return {
        provider,
        ...(providerDescriptor.generateTitle && {
            async generateTitle(context: AgentPasteSummaryGenerationContext): Promise<string> {
                const executable = await discoverExecutable(provider, launchSettings().executable);
                const version = executable ? await readVersion(provider, executable) : undefined;
                if (!executable || !version)
                    throw new CaxriError('UNAVAILABLE', 'Title generation is unavailable');
                return providerDescriptor.generateTitle!({
                    ...context,
                    environment,
                    executable,
                    version,
                });
            },
        }),
        ...(pasteSummary && {
            async summarizePaste(context: AgentPasteSummaryGenerationContext): Promise<string> {
                const executable = await discoverExecutable(provider, launchSettings().executable);
                if (!executable)
                    throw new CaxriError(
                        'UNAVAILABLE',
                        `${agentProviderCatalog[provider].displayName} is not available`,
                    );
                const version = await readVersion(provider, executable);
                if (!version)
                    throw new CaxriError(
                        'UNAVAILABLE',
                        `${agentProviderCatalog[provider].displayName} version could not be verified`,
                    );
                return pasteSummary.summarize({
                    ...context,
                    environment,
                    executable,
                    version,
                });
            },
        }),
        async renameSession(context): Promise<AgentSessionRenameResult> {
            if (!providerDescriptor.renameSession)
                throw new CaxriError(
                    'UNAVAILABLE',
                    `${agentProviderCatalog[provider].displayName} does not support native Session renaming`,
                );
            const executable = await discoverExecutable(provider, launchSettings().executable);
            if (!executable)
                throw new CaxriError(
                    'UNAVAILABLE',
                    `${agentProviderCatalog[provider].displayName} is not available`,
                );
            const version = await readVersion(provider, executable);
            if (!version)
                throw new CaxriError(
                    'UNAVAILABLE',
                    `${agentProviderCatalog[provider].displayName} version could not be verified`,
                );
            return providerDescriptor.renameSession({
                ...context,
                environment,
                executable,
                version,
            });
        },
        async snapshot(context): Promise<AgentSnapshot> {
            const observedAt = Date.now();
            const [executable, localState] = await Promise.all([
                discoverExecutable(provider, launchSettings().executable),
                providerDescriptor.readState(context, environment),
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
                titleSource: localState?.titleSource,
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

/**
 * A probe slower than this is worth surfacing at 'info' even when `available` did not change, since it is the signal an
 * operator needs to notice a stalled executable discovery or version read.
 */
export const SLOW_AGENT_PROBE_MS = 250;

export class AgentService {
    private readonly requests = new SingleFlight<string, AgentSnapshot>();
    /**
     * Tracks the last observed `available` per provider so `snapshot()` can log at 'info' only on a real availability
     * transition, not on every probe. See `snapshot()`'s rationale below.
     */
    private readonly lastAvailableByProvider = new Map<AgentProvider, boolean>();

    constructor(
        private readonly logger?: StructuredLogger,
        private readonly adapters: Record<AgentProvider, AgentAdapter> = createLocalAgentAdapters(),
    ) {}

    generateTitle(
        provider: AgentProvider,
        context: AgentPasteSummaryGenerationContext,
    ): Promise<string> {
        const adapter = this.adapters[provider];
        return adapter.generateTitle
            ? adapter.generateTitle(context)
            : Promise.reject(new CaxriError('UNAVAILABLE', 'Title generation is unavailable'));
    }

    snapshot(provider: AgentProvider, context?: AgentSnapshotContext): Promise<AgentSnapshot> {
        const resolvedContext = context ?? { rootPath: process.cwd() };
        return this.requests.run(snapshotRequestKey(provider, resolvedContext), async () => {
            const startedAt = performance.now();
            const snapshot = await this.adapters[provider].snapshot(resolvedContext);
            const durationMs = performance.now() - startedAt;
            const previousAvailable = this.lastAvailableByProvider.get(provider);
            this.lastAvailableByProvider.set(provider, snapshot.available);
            /**
             * Production evidence: `agent.probe` at unconditional 'info' produced 10,520 info lines across 5 days (~80%
             * of server-core.jsonl), evicting real incidents from the single 5MB log generation within hours. Every
             * provider is polled repeatedly while idle, so an unconditional line is almost always uninformative; only
             * an availability transition or an unusually slow probe is worth 'info'. The first probe of a provider
             * counts as a transition so startup timing (see the `performance` skill) keeps its `agent.probe` record.
             */
            const level =
                previousAvailable !== snapshot.available || durationMs > SLOW_AGENT_PROBE_MS
                    ? 'info'
                    : 'debug';
            this.logger?.write(level, logEventCatalog.agent.probe, {
                correlationId: resolvedContext.correlationId,
                durationMs,
                fields: { provider, available: snapshot.available },
            });
            return snapshot;
        });
    }

    renameSession(
        provider: AgentProvider,
        context: AgentSessionRenameContext,
    ): Promise<AgentSessionRenameResult> {
        return this.adapters[provider].renameSession(context);
    }

    summarizePaste(
        provider: AgentProvider,
        context: AgentPasteSummaryGenerationContext,
    ): Promise<string> {
        return this.adapters[provider].summarizePaste
            ? this.adapters[provider].summarizePaste(context)
            : Promise.reject(
                  new CaxriError(
                      'UNAVAILABLE',
                      `${agentProviderCatalog[provider].displayName} paste summaries are unavailable`,
                  ),
              );
    }
}
