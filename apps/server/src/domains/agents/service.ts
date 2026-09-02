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
    AgentSessionTitleGenerationContext,
    AgentSnapshotContext,
    AgentTitleSource,
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
    generateSessionTitle?(context: AgentSessionTitleGenerationContext): Promise<string>;
    provider: AgentProvider;
    readTitleOwnership?(
        context: AgentSnapshotContext,
    ): Promise<Pick<AgentTitleSource, 'currentProviderTitle' | 'providerTitleState'>>;
    readTitleSource?(context: AgentSnapshotContext): Promise<AgentTitleSource | undefined>;
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
    const naming = providerDescriptor.naming;
    const pasteSummary = providerDescriptor.pasteSummary;
    return {
        provider,
        ...(naming && {
            async generateSessionTitle(
                context: AgentSessionTitleGenerationContext,
            ): Promise<string> {
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
                return naming.generateTitle({
                    ...context,
                    environment,
                    executable,
                    version,
                });
            },
            readTitleSource: (context: AgentSnapshotContext) =>
                naming.readSource(context, environment),
            readTitleOwnership: (context: AgentSnapshotContext) =>
                naming.readOwnership(context, environment),
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
             * an availability transition or an unusually slow probe is worth 'info'.
             */
            const level =
                (previousAvailable !== undefined && previousAvailable !== snapshot.available) ||
                durationMs > SLOW_AGENT_PROBE_MS
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

    readTitleSource(
        provider: AgentProvider,
        context: AgentSnapshotContext,
    ): Promise<AgentTitleSource | undefined> {
        return this.adapters[provider].readTitleSource
            ? this.adapters[provider].readTitleSource(context)
            : Promise.reject(
                  new CaxriError(
                      'UNAVAILABLE',
                      `${agentProviderCatalog[provider].displayName} automatic naming is unavailable`,
                  ),
              );
    }

    readTitleOwnership(
        provider: AgentProvider,
        context: AgentSnapshotContext,
    ): Promise<Pick<AgentTitleSource, 'currentProviderTitle' | 'providerTitleState'>> {
        return this.adapters[provider].readTitleOwnership
            ? this.adapters[provider].readTitleOwnership(context)
            : Promise.reject(
                  new CaxriError(
                      'UNAVAILABLE',
                      `${agentProviderCatalog[provider].displayName} automatic naming is unavailable`,
                  ),
              );
    }

    generateSessionTitle(
        provider: AgentProvider,
        context: AgentSessionTitleGenerationContext,
    ): Promise<string> {
        return this.adapters[provider].generateSessionTitle
            ? this.adapters[provider].generateSessionTitle(context)
            : Promise.reject(
                  new CaxriError(
                      'UNAVAILABLE',
                      `${agentProviderCatalog[provider].displayName} automatic naming is unavailable`,
                  ),
              );
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
