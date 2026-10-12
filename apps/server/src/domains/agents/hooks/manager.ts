import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentHookHealth,
    AgentHookHealthMap,
    AgentProvider,
    AgentProviderSettings,
    ServerEvent,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    agentProviderIds,
    CaxriError,
    errorMessage,
    isCaxriError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';

import { atomicWrite, atomicWriteUserConfig } from '../../atomic-file';
import { WatchHub } from '../../watch';
import type { AgentEnvironment } from '../contract';
import { agentProviders } from '../providers';
import { stageAgentHookBridge } from './bridge';
import {
    isFileSystemError,
    readConfigDocuments,
    ReconciledConfigDocuments,
} from './config-documents';
import { AgentHookConfigWatchers } from './config-watchers';
import type {
    AgentHookAdapter,
    AgentHookConfigTarget,
    AgentHookDocuments,
    AgentHookEntryStatus,
    AgentLifecycleSignal,
    AgentSignalDecision,
    DesiredHookInstall,
} from './contract';
import type { HookExecutableDiscovery } from './executable-gate';
import { gateHookSettingsOnExecutables } from './executable-gate';
import { defaultHookHealth, hookHealthFor } from './health';
import { withAgentHookInstallLock } from './install-lock';
import { HookLaunchRegistry } from './launch-registry';
import { parseProfileIntents, serializeProfileIntents } from './profile-intents';
import { SerialTasks } from './serial-tasks';
import type { HookWireAttention } from './server';
import { AgentHookServer } from './server';
import { prepareAgentHookSocketPath } from './socket-path';
import { AgentHookTelemetry } from './telemetry';

const CONFIG_WATCH_SETTLE_MS = 100;
const MAX_CONCURRENT_PROFILE_STATS = 8;
/**
 * Provider-owned hook configs are small user-authored documents; never hand unbounded input to their syntax adapters or
 * let reconciliation rewrite a file it could not safely inspect.
 */
export const MAX_AGENT_HOOK_CONFIG_BYTES = 1 * 1024 * 1024;

interface AgentHookManagerOptions {
    /**
     * Resolves the provider CLI on this machine. Lifecycle hooks default to enabled, but a provider whose CLI is not
     * installed must not have Caxri write into its configuration directory or claim it in the shared profile registry:
     * the setting stays on, the installation simply waits for the CLI to appear.
     */
    discoverExecutable: HookExecutableDiscovery;
    environment: AgentEnvironment;
    logger: StructuredLogger;
    onAuthorityLost: (provider: AgentProvider) => void;
    onLaunchEnded: (terminalId: string) => void;
    onLaunchStarted: (terminalId: string, launchId: string) => void;
    onSignal: (signal: AgentLifecycleSignal) => AgentSignalDecision | Promise<AgentSignalDecision>;
    onAttention?: (
        request: HookWireAttention,
        signal: AbortSignal,
    ) => Promise<{
        decision?: 'allow' | 'deny';
        answers?: Record<string, string>;
    } | null>;
    hookExecutable: string;
    /**
     * Per-provider schema version this instance writes as the provider-file ordering token, announces to the bridge,
     * and accepts on the socket. Production derives it from the registered provider adapters; the multi-build
     * integration test substitutes a sibling build's value so two instances with different versions share one file.
     */
    schemaVersions?: Partial<Record<AgentProvider, number>>;
    send: (event: ServerEvent) => void;
    sharedPath?: string;
    userDataPath: string;
    /**
     * Shared Server watch registry. Production passes the Server-wide hub; tests may omit it, in which case the manager
     * owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}

/**
 * Generic lifecycle-hook owner. Provider adapters define config syntax only; this class owns the cross-process lock,
 * atomic filesystem changes, bridge/server lifecycle, health, and PTY tokens.
 */
export class AgentHookManager {
    private readonly activeProviders = new Set<AgentProvider>();
    private bridgePath?: string;
    private closed = false;
    private configReconcileTimer?: NodeJS.Timeout;
    private readonly configWatchers: AgentHookConfigWatchers;
    private readonly watchHub: WatchHub;
    private readonly ownsWatchHub: boolean;
    private health = defaultHookHealth();
    private launchSettings?: Record<AgentProvider, AgentProviderSettings>;
    /**
     * `reconcile()` clears `launchSettings` for new settings; a provider config edit (watcher or poll) queues
     * `reconcileNow` directly, because its unchanged settings keep the last gated launch view valid. An Agent launched
     * meanwhile then still gets its hook environment, not an empty one (Claude, Codex) or `UNAVAILABLE` (Grok).
     */
    private readonly reconcileQueue = new SerialTasks();
    private server?: AgentHookServer;
    private settings?: Record<AgentProvider, AgentProviderSettings>;
    private requestedSettings?: Record<AgentProvider, AgentProviderSettings>;
    private readonly telemetry: AgentHookTelemetry;
    private readonly launches: HookLaunchRegistry;
    /**
     * Providers whose last repair left the config short of `current`, so the non-convergence warning fires once per
     * transition instead of on every watcher-triggered reconcile.
     */
    private readonly nonConvergentProviders = new Set<AgentProvider>();
    private readonly profileId: string;
    private readonly reconciledDocuments = new ReconciledConfigDocuments(
        MAX_AGENT_HOOK_CONFIG_BYTES,
    );
    private readonly schemaVersions: Record<AgentProvider, number>;

    constructor(private readonly options: AgentHookManagerOptions) {
        this.telemetry = new AgentHookTelemetry(options.logger);
        this.launches = new HookLaunchRegistry({
            activate: (terminalId, launch) => {
                this.telemetry.beginLaunch(terminalId, launch.provider);
                options.onLaunchStarted(terminalId, launch.launchId);
                options.logger.write('info', logEventCatalog.agentHooks.launchPrepared, {
                    fields: {
                        stage: 'serverCore',
                        terminalId,
                        ...(launch.provider && { provider: launch.provider }),
                    },
                });
            },
            deactivate: (terminalId) => {
                this.telemetry.endLaunch(terminalId);
                options.onLaunchEnded(terminalId);
            },
            register: (terminalId, launchId, provider) =>
                this.server!.register(terminalId, launchId, provider),
            unregister: (token) => this.server?.unregister(token),
        });
        this.schemaVersions = Object.fromEntries(
            agentProviderIds.map((provider) => [
                provider,
                options.schemaVersions?.[provider] ??
                    agentProviders[provider].hooks?.schemaVersion ??
                    0,
            ]),
        ) as Record<AgentProvider, number>;
        this.ownsWatchHub = !options.watchHub;
        this.watchHub = options.watchHub ?? new WatchHub({ logger: options.logger });
        this.configWatchers = new AgentHookConfigWatchers({
            watchHub: this.watchHub,
            onChange: () => this.scheduleConfigReconcile(),
            pollOnce: async () => {
                const requested = this.requestedSettings;
                if (requested && this.anyEnabled())
                    await this.reconcileQueue.run(() => this.reconcileNow(requested));
            },
        });
        this.profileId = createHash('sha256')
            .update(options.userDataPath)
            .digest('hex')
            .slice(0, 16);
    }

    private async reconcileNow(
        requested: Record<AgentProvider, AgentProviderSettings>,
    ): Promise<void> {
        if (this.closed || !this.options.sharedPath || !this.bridgePath) return;
        const { effective: settings, missing } = await gateHookSettingsOnExecutables(
            requested,
            this.options.discoverExecutable,
        );
        /**
         * Every later consumer (signal handler, `markActive`, `anyEnabled`, watcher polling) must see the gated view: a
         * hook signal for a provider whose CLI Caxri could not resolve came from another installation and must not flip
         * this profile's health to `active`.
         */
        if (this.requestedSettings !== requested) return;
        const installHints = new Map<AgentProvider, string>();
        for (const provider of missing) {
            const message = `Install the ${agentProviderCatalog[provider].displayName} CLI, then restart Caxri.`;
            installHints.set(provider, message);
            // Logged on the transition into the missing state only; a steady-state reconcile repeats nothing.
            if (this.health[provider].message !== message)
                this.options.logger.write('info', logEventCatalog.agentHooks.executableMissing, {
                    fields: { provider },
                });
        }
        try {
            await this.withInstallLock(async () => {
                // Missing CLI availability is temporary; only explicit requested settings change profile intent.
                const globallyEnabled = await this.updateProfileIntent(requested);
                /**
                 * Provider adapters own disjoint config files; the shared profile registry is already durable before
                 * these independent reconciliations begin.
                 */
                await Promise.all(
                    agentProviderIds.map((provider) =>
                        this.reconcileProvider(
                            provider,
                            globallyEnabled[provider],
                            settings[provider].hooks.enabled,
                            installHints.get(provider),
                        ),
                    ),
                );
            });
            const watchesNewTargets = await this.configWatchers.refresh(this.configPaths(settings));
            if (this.requestedSettings === requested) {
                this.settings = settings;
                this.launchSettings = settings;
            }
            // An edit can land on a newly watched file between the reads above and its watcher going live.
            if (watchesNewTargets && (await this.reconciledDocuments.changed()))
                this.scheduleConfigReconcile();
        } catch (error) {
            if (this.requestedSettings !== requested) return;
            const message = errorMessage(error, 'Lifecycle hook reconciliation failed');
            for (const provider of agentProviderIds)
                if (settings[provider].hooks.enabled)
                    this.setHealth(provider, { kind: 'error', message });
            this.options.logger.write('warn', logEventCatalog.agentHooks.lockFailed, {
                fields: { error: message },
            });
        }
    }

    /**
     * `installHint` is set when the provider is enabled but its CLI could not be resolved; the provider is then
     * reconciled as locally disabled and its `notInstalled` health carries the hint.
     */
    private async reconcileProvider(
        provider: AgentProvider,
        isGloballyEnabled: boolean,
        isLocallyEnabled: boolean,
        installHint?: string,
    ): Promise<void> {
        const adapter = agentProviders[provider].hooks;
        if (!adapter) {
            this.loseAuthority(provider);
            this.setHealth(provider, { kind: 'unsupported' });
            return;
        }
        const support = adapter.supports(undefined);
        if (!support.supported) {
            this.loseAuthority(provider);
            this.setHealth(provider, { kind: 'unsupported', message: support.reason });
            return;
        }
        this.reconciledDocuments.forget(provider);
        try {
            const targets = adapter.configTargets(this.options.environment);
            const targetById = new Map(targets.map((target) => [target.id, target]));
            let documents = await readConfigDocuments(targets, MAX_AGENT_HOOK_CONFIG_BYTES);
            let status = adapter.inspect(documents, this.desired(provider)).status;
            if (!isGloballyEnabled) {
                this.loseAuthority(provider);
                if (!['absent', 'newer', 'newerIncomplete', 'unparseable'].includes(status.kind)) {
                    await this.writeEdits(
                        adapter.remove(documents, this.desired(provider)),
                        documents,
                        targetById,
                        provider,
                        'remove',
                        status.kind,
                    );
                    documents = await readConfigDocuments(targets, MAX_AGENT_HOOK_CONFIG_BYTES);
                    status = adapter.inspect(documents, this.desired(provider)).status;
                }
                const health = hookHealthFor(status, false, this.schemaVersions[provider]);
                this.setHealth(
                    provider,
                    installHint && health.kind === 'notInstalled'
                        ? { kind: 'notInstalled', message: installHint }
                        : health,
                );
                return;
            }
            /**
             * Other profiles protect removal but never grant this profile install or repair authority.
             */
            if (!isLocallyEnabled) {
                this.loseAuthority(provider);
                this.setHealth(provider, {
                    kind: 'notInstalled',
                    ...(installHint && { message: installHint }),
                });
                return;
            }
            /**
             * What this reconcile left in the files: its own writes rather than the re-read below, so an edit that
             * lands between the write and that re-read still reads as a change to the post-refresh check.
             */
            let reconciled = documents;
            if (['absent', 'stale', 'drifted'].includes(status.kind)) {
                this.loseAuthority(provider);
                const fromStatus = status.kind;
                const action = fromStatus === 'absent' ? 'install' : 'repair';
                const { contents, written } = await this.writeEdits(
                    adapter.render(documents, this.desired(provider)),
                    documents,
                    targetById,
                    provider,
                    action,
                    fromStatus,
                );
                reconciled = contents;
                documents = await readConfigDocuments(targets, MAX_AGENT_HOOK_CONFIG_BYTES);
                status = adapter.inspect(documents, this.desired(provider)).status;
                this.recordConvergence(provider, action, fromStatus, status.kind, written);
            } else if (status.kind === 'current') this.nonConvergentProviders.delete(provider);
            this.reconciledDocuments.remember(provider, targets, reconciled);
            if (status.kind !== 'current' && status.kind !== 'newer') this.loseAuthority(provider);
            this.setHealth(
                provider,
                hookHealthFor(
                    status,
                    this.activeProviders.has(provider),
                    this.schemaVersions[provider],
                ),
            );
        } catch (error) {
            const message = errorMessage(error, 'Lifecycle hook reconciliation failed');
            this.loseAuthority(provider);
            /**
             * `atomicWriteUserConfig` refuses a config symlink whose target is missing with `CONFLICT`. Only the user
             * can restore or replace that link and restarting Agent Terminals changes nothing, so it is a `conflict`
             * naming the link rather than a retryable `error`; the watcher on the link target's directory reconciles
             * again once the target returns.
             */
            this.setHealth(provider, {
                kind: isCaxriError(error) && error.code === 'CONFLICT' ? 'conflict' : 'error',
                message,
            });
            this.options.logger.write('warn', logEventCatalog.agentHooks.reconcileFailed, {
                fields: { provider, error: message },
            });
        }
    }

    private desired(provider: AgentProvider): DesiredHookInstall {
        return {
            bridgePath: this.bridgePath!,
            provider,
            schemaVersion: this.schemaVersions[provider],
        };
    }

    /**
     * The schema an instance validates against travels with the launch, never with the shared provider file. The
     * `--schema` literal in `~/.claude/settings.json` or Codex's `hooks.json` belongs to whichever build last won the
     * file, so reading it back would make a superseded build reject its own signals; this environment is the only place
     * this instance's expectation can be introduced (issue #557).
     */
    private schemaEnvironment(): NodeJS.ProcessEnv {
        return Object.fromEntries(
            agentProviderIds.map((provider) => [
                `CAXRI_HOOK_SCHEMA_${provider.toUpperCase()}`,
                String(this.schemaVersions[provider]),
            ]),
        );
    }

    /**
     * Provider configs are user-global while Caxri settings are profile-scoped. Persisting the union of profile intents
     * prevents one worktree/profile from uninstalling hooks that another profile still explicitly enables; missing
     * profile directories are pruned so explicit profile cleanup cannot leave an unremovable global hook.
     */
    private async updateProfileIntent(
        settings: Record<AgentProvider, AgentProviderSettings>,
    ): Promise<Record<AgentProvider, boolean>> {
        const path = join(this.options.sharedPath!, 'profile-intents.json');
        let source: string | undefined;
        try {
            source = await readFile(path, 'utf8');
        } catch (error) {
            if (!isFileSystemError(error, 'ENOENT')) throw error;
        }
        const registry = parseProfileIntents(source);
        const staleProfileIds = await mapWithConcurrency(
            Object.entries(registry.profiles),
            MAX_CONCURRENT_PROFILE_STATS,
            async ([profileId, intent]) => {
                try {
                    return (await lstat(intent.profilePath)).isDirectory() ? undefined : profileId;
                } catch (error) {
                    if (isFileSystemError(error, 'ENOENT')) return profileId;
                    throw error;
                }
            },
        );
        for (const profileId of staleProfileIds)
            if (profileId !== undefined) delete registry.profiles[profileId];
        const providers = agentProviderIds.filter((provider) => settings[provider].hooks.enabled);
        if (providers.length > 0)
            registry.profiles[this.profileId] = {
                profilePath: this.options.userDataPath,
                providers,
            };
        else delete registry.profiles[this.profileId];
        const next = serializeProfileIntents(registry);
        if (source !== next) await atomicWrite(path, next);
        return Object.fromEntries(
            agentProviderIds.map((provider) => [
                provider,
                Object.values(registry.profiles).some((intent) =>
                    intent.providers.includes(provider),
                ),
            ]),
        ) as Record<AgentProvider, boolean>;
    }

    /**
     * Applies an adapter's edit plan and audits each write. The audit exists because these edits rewrite user-global
     * provider config (`~/.claude/settings.json` and Codex's equivalent) that other tools also write: without it, a
     * hook that vanished has no local timeline. `action` and `fromStatus` separate a first install from a repair of
     * drifted entries and from an uninstall. Only the symbolic target id is recorded, never the path or the source.
     */
    private async writeEdits(
        edits: ReturnType<AgentHookAdapter['render']>,
        documents: AgentHookDocuments,
        targetById: ReadonlyMap<string, AgentHookConfigTarget>,
        provider: AgentProvider,
        action: 'install' | 'remove' | 'repair',
        fromStatus: AgentHookEntryStatus['kind'],
    ): Promise<{ contents: AgentHookDocuments; written: number }> {
        const contents = new Map(documents);
        let written = 0;
        /**
         * Adapter edits are an ordered transaction plan; parallel replacement could expose a mixed provider
         * configuration or overwrite a later edit to the same target.
         */
        for (const edit of edits) {
            const target = targetById.get(edit.targetId);
            if (!target?.writable)
                throw new Error(
                    `Hook adapter attempted to write read-only target ${edit.targetId}`,
                );
            /**
             * A byte-identical rewrite still fires the config watcher, which schedules another reconcile. Skipping it
             * keeps an edit plan that cannot reach `current` from turning into a self-sustaining write loop.
             */
            if (contents.get(edit.targetId) === edit.source) continue;
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: edits must apply in order
            await atomicWriteUserConfig(target.path, edit.source);
            contents.set(edit.targetId, edit.source);
            written += 1;
            this.options.logger.write('info', logEventCatalog.agentHooks.configWritten, {
                fields: {
                    stage: 'serverCore',
                    action,
                    fromStatus,
                    provider,
                    targetId: edit.targetId,
                },
            });
        }
        return { contents, written };
    }

    /**
     * An install or repair that leaves the provider config short of `current` means the adapter's edit plan and its
     * inspection disagree, or another writer undid the edit. Recorded once per transition with the edit count, so a
     * plan that cannot converge is visible without the watcher loop it used to cause.
     */
    private recordConvergence(
        provider: AgentProvider,
        action: 'install' | 'repair',
        fromStatus: AgentHookEntryStatus['kind'],
        toStatus: AgentHookEntryStatus['kind'],
        written: number,
    ): void {
        if (toStatus === 'current') {
            this.nonConvergentProviders.delete(provider);
            return;
        }
        if (this.nonConvergentProviders.has(provider)) return;
        this.nonConvergentProviders.add(provider);
        this.options.logger.write('warn', logEventCatalog.agentHooks.repairNotConverged, {
            fields: { stage: 'serverCore', provider, action, fromStatus, toStatus, written },
        });
    }

    private setHealth(provider: AgentProvider, health: AgentHookHealth): void {
        const next: AgentHookHealth = {
            kind: health.kind,
            ...(health.message && { message: health.message }),
            ...(health.installedSchema !== undefined && {
                installedSchema: health.installedSchema,
            }),
        };
        const previous = this.health[provider];
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        this.health = { ...this.health, [provider]: next };
        /**
         * Closed states, installed schema, and the hashed profile identify which build's installation changed. Adapter
         * messages may quote provider configuration, so they remain on Settings and never enter diagnostics.
         */
        this.options.logger.write('info', logEventCatalog.agentHooks.healthChanged, {
            fields: {
                stage: 'serverCore',
                provider,
                profileId: this.profileId,
                ...(next.installedSchema !== undefined && {
                    installedSchema: next.installedSchema,
                }),
                from: previous.kind,
                to: next.kind,
            },
        });
        this.options.send({ event: 'agentHooks.changed', payload: this.getHealth() });
    }

    private loseAuthority(provider: AgentProvider): void {
        if (this.activeProviders.delete(provider)) this.options.onAuthorityLost(provider);
    }

    private markActive(provider: AgentProvider): void {
        if (!this.settings?.[provider].hooks.enabled) return;
        if (!['installedPending', 'active'].includes(this.health[provider].kind)) return;
        this.activeProviders.add(provider);
        this.setHealth(provider, {
            kind: 'active',
            installedSchema: this.health[provider].installedSchema,
        });
    }

    private anyEnabled(): boolean {
        return agentProviderIds.some(
            (provider) => this.settings?.[provider].hooks.enabled === true,
        );
    }

    private anyLaunchEnabled(): boolean {
        return agentProviderIds.some(
            (provider) => this.launchSettings?.[provider].hooks.enabled === true,
        );
    }

    /**
     * Config files of every enabled provider whose adapter runs on this platform: the files the watchers cover.
     */
    private configPaths(settings: Record<AgentProvider, AgentProviderSettings>): string[] {
        return agentProviderIds.flatMap((provider) => {
            const adapter = agentProviders[provider].hooks;
            if (!settings[provider].hooks.enabled || !adapter?.supports(undefined).supported)
                return [];
            return adapter.configTargets(this.options.environment).map((target) => target.path);
        });
    }

    private scheduleConfigReconcile(): void {
        if (this.closed || !this.settings) return;
        if (this.configReconcileTimer) clearTimeout(this.configReconcileTimer);
        this.configReconcileTimer = setTimeout(() => {
            this.configReconcileTimer = undefined;
            const requested = this.requestedSettings;
            // eslint-disable-next-line no-void -- synchronous timer callback cannot await; reconcileNow() never rejects (errors are caught and logged internally)
            if (requested) void this.reconcileQueue.run(() => this.reconcileNow(requested));
        }, CONFIG_WATCH_SETTLE_MS);
        this.configReconcileTimer.unref();
    }

    private withInstallLock<T>(operation: () => Promise<T>): Promise<T> {
        return withAgentHookInstallLock(this.options.sharedPath!, operation);
    }

    private launchEnvironment(
        terminalId: string,
        { launchId, token }: { launchId: string; token: string },
    ): NodeJS.ProcessEnv {
        return {
            CAXRI_HOOK_LAUNCH_ID: launchId,
            /**
             * New staged bridges remain compatible with older Server builds unless this launch explicitly opts in.
             */
            CAXRI_HOOK_RECEIPTS: '1',
            CAXRI_HOOK_RUNTIME: this.options.hookExecutable,
            CAXRI_HOOK_SOCKET: this.server!.socketPath,
            CAXRI_HOOK_TERMINAL_ID: terminalId,
            CAXRI_HOOK_TOKEN: token,
            ...this.schemaEnvironment(),
        };
    }

    async initialize(settings: Record<AgentProvider, AgentProviderSettings>): Promise<void> {
        this.requestedSettings = settings;
        this.settings = undefined;
        this.launchSettings = undefined;
        if (!this.options.sharedPath) {
            this.health = defaultHookHealth(
                'Lifecycle hook installation is unavailable in this mode.',
            );
            return;
        }
        try {
            await mkdir(this.options.sharedPath, { recursive: true });
            this.bridgePath = await this.withInstallLock(() =>
                stageAgentHookBridge(this.options.sharedPath!),
            );
            const socketPath = await prepareAgentHookSocketPath(this.profileId);
            this.server = new AgentHookServer(
                socketPath,
                this.schemaVersions,
                async (signal) => {
                    if (
                        !this.settings?.[signal.provider].hooks.enabled ||
                        !this.requestedSettings?.[signal.provider].hooks.enabled
                    )
                        return { disposition: 'ignored', reason: 'hooksDisabled' };
                    try {
                        const decision = await this.options.onSignal(signal);
                        if (decision !== 'accepted')
                            return { disposition: 'ignored', reason: decision };
                        this.markActive(signal.provider);
                        return { disposition: 'accepted' };
                    } catch (error) {
                        this.options.logger.write('warn', logEventCatalog.agentHooks.signalFailed, {
                            fields: {
                                provider: signal.provider,
                                phase: signal.phase,
                                terminalId: signal.terminalId,
                                error: errorMessage(error, 'Lifecycle signal failed'),
                            },
                        });
                        return { disposition: 'rejected' };
                    }
                },
                (diagnostic) => this.telemetry.record(diagnostic),
                async (request, signal) => {
                    if (
                        !this.settings?.claude.hooks.enabled ||
                        !this.requestedSettings?.claude.hooks.enabled
                    )
                        return null;
                    return this.options.onAttention?.(request, signal) ?? null;
                },
            );
            await this.server.start();
            await this.reconcile(settings);
        } catch (error) {
            const message = errorMessage(error, 'Lifecycle hook initialization failed');
            this.options.logger.write('warn', logEventCatalog.agentHooks.initializeFailed, {
                fields: { error: message },
            });
            for (const provider of agentProviderIds)
                this.setHealth(provider, { kind: 'error', message });
        }
    }

    getHealth(): AgentHookHealthMap {
        return structuredClone(this.health);
    }

    reconcile(settings: Record<AgentProvider, AgentProviderSettings>): Promise<void> {
        this.requestedSettings = settings;
        // A managed launch must not combine requested settings with health from the previous executable gate.
        this.launchSettings = undefined;
        return this.reconcileQueue.run(() => this.reconcileNow(settings));
    }

    terminalEnvironment(
        terminalId: string,
        provider?: AgentProvider,
        launchId: string = randomUUID(),
    ): NodeJS.ProcessEnv {
        if (
            provider &&
            agentProviders[provider].requiresLifecycleHooks &&
            (!this.server ||
                !this.bridgePath ||
                !this.launchSettings?.[provider].hooks.enabled ||
                !['active', 'installedPending'].includes(this.health[provider].kind))
        )
            throw new CaxriError(
                'UNAVAILABLE',
                `${agentProviderCatalog[provider].displayName} requires installed lifecycle hooks for reliable Session identity`,
            );
        if (!this.server || !this.bridgePath || !this.anyLaunchEnabled()) return {};
        return this.launchEnvironment(
            terminalId,
            this.launches.agent(terminalId, launchId, provider),
        );
    }

    shellEnvironment(terminalId: string): NodeJS.ProcessEnv {
        if (!this.server || !this.bridgePath || !this.anyLaunchEnabled()) return {};
        return this.launchEnvironment(terminalId, this.launches.shell(terminalId));
    }

    endTerminalLaunch(terminalId: string, expectedLaunchId?: string): void {
        this.launches.endAgent(terminalId, expectedLaunchId);
    }

    endShellLaunch(terminalId: string): void {
        this.launches.endShell(terminalId);
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.configReconcileTimer) clearTimeout(this.configReconcileTimer);
        this.configReconcileTimer = undefined;
        await this.reconcileQueue.idle();
        await this.configWatchers.close();
        if (this.ownsWatchHub) await this.watchHub.close();
        this.launches.close();
        await this.server?.close();
        this.server = undefined;
    }
}
