import process from 'node:process';

import type {
    AgentActivityState,
    AgentLaunchSettings,
    AgentProvider,
    SessionAttentionKind,
} from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, SingleFlight } from '@caxri/system';

import type { AgentUsageGuards } from '../usage';
import type {
    AgentEnvironment,
    AgentLowCostGenerationContext,
    AgentProbeCacheCounters,
    AgentProbeSnapshot,
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
    generateTitle?(context: AgentLowCostGenerationContext): Promise<string>;
    /**
     * Diagnostics only, kept off `snapshot()`'s result so cache accounting never travels with a probe answer to the
     * Renderer. `snapshot()` reads it after the probe resolves.
     */
    probeCacheCounters?(): AgentProbeCacheCounters;
    provider: AgentProvider;
    renameSession(context: AgentSessionRenameContext): Promise<AgentSessionRenameResult>;
    snapshot(context: AgentSnapshotContext): Promise<AgentProbeSnapshot>;
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
        context.requireForegroundProcessIdentity ?? false,
        context.processState ?? null,
        context.startedAt ?? null,
    ]);
}

/**
 * Log fields are flat scalars, so the counters are prefixed rather than nested. The prefix also keeps a provider's own
 * miss-reason keys from colliding with an unrelated probe field as more providers gain caches.
 */
function cacheCounterFields(counters: AgentProbeCacheCounters | undefined): Record<string, number> {
    if (!counters) return {};
    return Object.fromEntries(
        Object.entries(counters).map(([key, value]) => [`cache.${key}`, value]),
    );
}

function createCliAdapter(
    provider: AgentProvider,
    environment: AgentEnvironment,
    launchSettings: () => AgentLaunchSettings,
): AgentAdapter {
    const providerDescriptor = agentProviders[provider];
    return {
        provider,
        ...(providerDescriptor.probeCacheCounters && {
            probeCacheCounters: providerDescriptor.probeCacheCounters,
        }),
        ...(providerDescriptor.generateTitle && {
            async generateTitle(context: AgentLowCostGenerationContext): Promise<string> {
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
        async renameSession(context): Promise<AgentSessionRenameResult> {
            /**
             * Unreachable in the product: `SessionRenameService` decides not to synchronize before it asks for an
             * adapter. Kept as an internal guard rather than user-facing copy: whether a provider implements rename at
             * all is not something to tell the user about their own Session name (issue #982).
             *
             * The three `UNAVAILABLE` throws below are a different case, and #982's "a Session title belongs to Caxri
             * and is committed either way" does not cover them yet: an Agent CLI that cannot be found on the resolved
             * PATH, or whose version cannot be read, still rejects the whole rename before the local title is
             * committed, so the user's typed name is discarded and the toast blames their CLI.
             */
            if (!providerDescriptor.renameSession)
                throw new CaxriError(
                    'INTERNAL',
                    `${provider} adapter has no renameSession implementation`,
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
        async snapshot(context): Promise<AgentProbeSnapshot> {
            const observedAt = Date.now();
            const [executable, localState] = await Promise.all([
                discoverExecutable(provider, launchSettings().executable),
                providerDescriptor.readState(context, environment),
            ]);
            const version = executable ? await readVersion(provider, executable) : undefined;
            return {
                provider,
                activitySource: localState?.activitySource,
                activityTurnId: localState?.activityTurnId,
                attentionKind: reliableAttentionKind(localState?.status),
                status: localState?.status ?? processStateToAgentActivity(context.processState),
                observedAt,
                available: Boolean(executable),
                executable,
                version,
                sessionId: localState?.sessionId,
                sessionIsSubagent: localState?.sessionIsSubagent,
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
    private readonly requests = new SingleFlight<string, AgentProbeSnapshot>();
    /**
     * Tracks the last observed `available` per provider so `snapshot()` can log at 'info' only on a real availability
     * transition, not on every probe. See `snapshot()`'s rationale below.
     */
    private readonly lastAvailableByProvider = new Map<AgentProvider, boolean>();

    constructor(
        private readonly logger?: StructuredLogger,
        private readonly adapters: Record<AgentProvider, AgentAdapter> = createLocalAgentAdapters(),
        /**
         * Refuses a title while the provider's account is at the weekly usage guard (issue #2580).
         */
        private readonly usageGuards?: Pick<AgentUsageGuards, 'assertAdmitted'>,
    ) {}

    async generateTitle(
        provider: AgentProvider,
        context: AgentLowCostGenerationContext,
    ): Promise<string> {
        this.usageGuards?.assertAdmitted(provider, 'auto_naming');
        const adapter = this.adapters[provider];
        if (!adapter.generateTitle)
            throw new CaxriError('UNAVAILABLE', 'Title generation is unavailable');
        return adapter.generateTitle(context);
    }

    snapshot(provider: AgentProvider, context?: AgentSnapshotContext): Promise<AgentProbeSnapshot> {
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
                /**
                 * `durationMs` alone cannot say whether a cache regressed, because it moves with machine load; the hit
                 * rate's slope across records can. The counters are cumulative precisely so that slope survives sparse
                 * sampling: Server Core runs its logger at 'info', so in production only an availability transition, a
                 * provider's first probe, and a slow probe keep their record. Any two surviving records still give the
                 * rate between them, which a per-probe delta could not.
                 */
                fields: {
                    provider,
                    available: snapshot.available,
                    ...cacheCounterFields(this.adapters[provider].probeCacheCounters?.()),
                },
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
}
