import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';

import parcelWatcher from '@parcel/watcher';

import type { AgentProvider, AgentProviderSettings } from '../../../shared/agents';
import { agentProviderIds } from '../../../shared/agents';
import { errorMessage } from '../../../shared/ipc/errors';
import type { RuntimeEvent } from '../../../shared/ipc/events';
import { mapWithConcurrency } from '../../../shared/node/concurrency';
import type { StructuredLogger } from '../../../shared/node/logger';
import type { AgentHookHealth, AgentHookHealthMap } from '../../../shared/types';
import { readBoundedRegularFileText } from '../../bounded-file-reader';
import { NATIVE_WATCHER_BACKEND } from '../../native-watcher';
import type { AgentEnvironment } from '../contract';
import { agentProviders } from '../providers';
import { stageAgentHookBridge } from './bridge';
import type {
    AgentHookAdapter,
    AgentHookConfigTarget,
    AgentHookDocuments,
    AgentHookEntryStatus,
    AgentLifecycleSignal,
} from './contract';
import { AgentHookServer, pruneStaleAgentHookSockets } from './server';

const CONFIG_WATCH_SETTLE_MS = 100;
const CONFIG_FALLBACK_POLL_INTERVAL_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_PROFILE_STATS = 8;
/**
 * Provider-owned hook configs are small user-authored documents; never hand unbounded input to
 * their syntax adapters or let reconciliation rewrite a file it could not safely inspect.
 */
export const MAX_AGENT_HOOK_CONFIG_BYTES = 1 * 1024 * 1024;
const STALE_LOCK_MS = 30_000;
const PROFILE_INTENTS_VERSION = 2;
const agentProviderIdSet = new Set<string>(agentProviderIds);

interface TerminalHookLaunch {
    launchId: string;
    token: string;
}

interface HookConfigWatcher {
    subscription: { unsubscribe(): Promise<void> };
    targets: Set<string>;
}

interface ProfileHookIntentRegistry {
    profiles: Record<string, { profilePath: string; providers: AgentProvider[] }>;
    version: typeof PROFILE_INTENTS_VERSION;
}

interface AgentHookManagerOptions {
    environment: AgentEnvironment;
    logger: StructuredLogger;
    onAuthorityLost: (provider: AgentProvider) => void;
    onLaunchEnded: (terminalId: string) => void;
    onLaunchStarted: (terminalId: string, launchId: string) => void;
    onSignal: (signal: AgentLifecycleSignal) => boolean;
    runtimeExecutable: string;
    send: (event: RuntimeEvent) => void;
    sharedPath?: string;
    userDataPath: string;
}

function defaultHealth(message?: string): AgentHookHealthMap {
    return Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            { kind: 'notInstalled', ...(message && { message }) },
        ]),
    ) as AgentHookHealthMap;
}

async function atomicWrite(path: string, source: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(source, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(dirname(path), 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

function isFileSystemError(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        Reflect.get(error, 'code') === code
    );
}

function parseProfileIntents(source: string | undefined): ProfileHookIntentRegistry {
    if (source === undefined) return { profiles: {}, version: PROFILE_INTENTS_VERSION };
    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch (error) {
        throw new Error('Caxri hook profile intents are not valid JSON', { cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Caxri hook profile intents are not an object');
    const record = value as Record<string, unknown>;
    if (record.version !== PROFILE_INTENTS_VERSION)
        throw new Error('Caxri hook profile intents use an unsupported version');
    if (typeof record.profiles !== 'object' || record.profiles === null)
        throw new Error('Caxri hook profile intents do not contain a profiles object');
    const profiles: ProfileHookIntentRegistry['profiles'] = {};
    for (const [profileId, candidate] of Object.entries(
        record.profiles as Record<string, unknown>,
    )) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            throw new Error('Caxri hook profile intent is not an object');
        const providers = (candidate as Record<string, unknown>).providers;
        const profilePath = (candidate as Record<string, unknown>).profilePath;
        if (
            typeof profilePath !== 'string' ||
            !isAbsolute(profilePath) ||
            !Array.isArray(providers) ||
            !providers.every(
                (provider): provider is AgentProvider =>
                    typeof provider === 'string' && agentProviderIdSet.has(provider),
            )
        ) {
            throw new Error('Caxri hook profile intent contains an invalid path or provider');
        }
        profiles[profileId] = { profilePath, providers: [...new Set(providers)] };
    }
    return { profiles, version: PROFILE_INTENTS_VERSION };
}

function serializeProfileIntents(registry: ProfileHookIntentRegistry): string {
    return `${JSON.stringify(
        {
            version: PROFILE_INTENTS_VERSION,
            profiles: Object.fromEntries(
                Object.entries(registry.profiles)
                    .toSorted(([left], [right]) => left.localeCompare(right))
                    .map(([profileId, intent]) => [
                        profileId,
                        {
                            profilePath: intent.profilePath,
                            providers: agentProviderIds.filter((provider) =>
                                intent.providers.includes(provider),
                            ),
                        },
                    ]),
            ),
        },
        null,
        2,
    )}\n`;
}

async function readTargets(targets: readonly AgentHookConfigTarget[]): Promise<AgentHookDocuments> {
    const entries = await Promise.all(
        targets.map(async (target) => {
            try {
                return [
                    target.id,
                    await readBoundedRegularFileText(target.path, MAX_AGENT_HOOK_CONFIG_BYTES, {
                        capacityMessage: `Agent hook configuration exceeds the ${MAX_AGENT_HOOK_CONFIG_BYTES} byte safety limit`,
                    }),
                ] as const;
            } catch (error) {
                if (isFileSystemError(error, 'ENOENT')) return [target.id, undefined] as const;
                throw error;
            }
        }),
    );
    return new Map(entries);
}

function healthFor(status: AgentHookEntryStatus, isActive: boolean): AgentHookHealth {
    if (status.kind === 'current')
        return isActive
            ? { kind: 'active' }
            : {
                  kind: 'installedPending',
                  message: 'Installed. Review and trust the hook in the Agent CLI if prompted.',
              };
    if (status.kind === 'absent') return { kind: 'notInstalled' };
    if (status.kind === 'stale')
        return {
            kind: 'stale',
            message: `Installed hook schema ${status.installedSchema} needs an update.`,
        };
    if (status.kind === 'newer')
        return {
            kind: 'newer',
            message: `Hook schema ${status.installedSchema} is newer than this Caxri version.`,
        };
    if (status.kind === 'conflict') return { kind: 'conflict', message: status.message };
    if (status.kind === 'unparseable') return { kind: 'error', message: status.message };
    return { kind: 'drifted', message: 'Caxri hook entries were edited outside Caxri.' };
}

/**
 * Generic lifecycle-hook owner. Provider adapters define config syntax only; this class owns the
 * cross-process lock, atomic filesystem changes, bridge/server lifecycle, health, and PTY tokens.
 */
export class AgentHookManager {
    private readonly activeProviders = new Set<AgentProvider>();
    private bridgePath?: string;
    private closed = false;
    private configFallbackTimer?: NodeJS.Timeout;
    private configReconcileTimer?: NodeJS.Timeout;
    private readonly configWatchers = new Map<string, HookConfigWatcher>();
    private health = defaultHealth();
    private reconcileQueue = Promise.resolve();
    private server?: AgentHookServer;
    private settings?: Record<AgentProvider, AgentProviderSettings>;
    private readonly terminalLaunches = new Map<string, TerminalHookLaunch>();
    private readonly profileId: string;

    constructor(private readonly options: AgentHookManagerOptions) {
        this.profileId = createHash('sha256')
            .update(options.userDataPath)
            .digest('hex')
            .slice(0, 16);
    }

    private async reconcileNow(
        settings: Record<AgentProvider, AgentProviderSettings>,
    ): Promise<void> {
        if (this.closed || !this.options.sharedPath || !this.bridgePath) return;
        try {
            await this.withInstallLock(async () => {
                const globallyEnabled = await this.updateProfileIntent(settings);
                /**
                 * Provider adapters own disjoint config files; the shared profile registry is
                 * already durable before these independent reconciliations begin.
                 */
                await Promise.all(
                    agentProviderIds.map((provider) =>
                        this.reconcileProvider(
                            provider,
                            globallyEnabled[provider],
                            settings[provider].hooks.enabled,
                        ),
                    ),
                );
            });
            await this.refreshConfigWatchers(settings);
        } catch (error) {
            const message = errorMessage(error, 'Lifecycle hook reconciliation failed');
            for (const provider of agentProviderIds)
                if (settings[provider].hooks.enabled)
                    this.setHealth(provider, { kind: 'error', message });
            this.options.logger.write('warn', 'agent_hooks.lock_failed', {
                fields: { error: message },
            });
        }
    }

    private async reconcileProvider(
        provider: AgentProvider,
        isGloballyEnabled: boolean,
        isLocallyEnabled: boolean,
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
        try {
            const targets = adapter.configTargets(this.options.environment);
            const targetById = new Map(targets.map((target) => [target.id, target]));
            let documents = await readTargets(targets);
            let status = adapter.inspect(documents, this.desired(provider, adapter)).status;
            if (!isGloballyEnabled) {
                this.loseAuthority(provider);
                if (!['absent', 'newer', 'unparseable'].includes(status.kind)) {
                    await this.writeEdits(
                        adapter.remove(documents, this.desired(provider, adapter)),
                        targetById,
                    );
                    documents = await readTargets(targets);
                    status = adapter.inspect(documents, this.desired(provider, adapter)).status;
                }
                this.setHealth(provider, healthFor(status, false));
                return;
            }
            if (['absent', 'stale', 'drifted'].includes(status.kind)) {
                this.loseAuthority(provider);
                await this.writeEdits(
                    adapter.render(documents, this.desired(provider, adapter)),
                    targetById,
                );
                documents = await readTargets(targets);
                status = adapter.inspect(documents, this.desired(provider, adapter)).status;
            }
            if (status.kind !== 'current') this.loseAuthority(provider);
            if (!isLocallyEnabled) {
                this.loseAuthority(provider);
                this.setHealth(provider, { kind: 'notInstalled' });
                return;
            }
            this.setHealth(provider, healthFor(status, this.activeProviders.has(provider)));
        } catch (error) {
            const message = errorMessage(error, 'Lifecycle hook reconciliation failed');
            this.loseAuthority(provider);
            this.setHealth(provider, { kind: 'error', message });
            this.options.logger.write('warn', 'agent_hooks.reconcile_failed', {
                fields: { provider, error: message },
            });
        }
    }

    private desired(provider: AgentProvider, adapter: AgentHookAdapter) {
        return {
            bridgePath: this.bridgePath!,
            provider,
            schemaVersion: adapter.schemaVersion,
        };
    }

    /**
     * Provider configs are user-global while Caxri settings are profile-scoped. Persisting the
     * union of profile intents prevents one worktree/profile from uninstalling hooks that another
     * profile still explicitly enables; missing profile directories are pruned so explicit profile
     * cleanup cannot leave an unremovable global hook.
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

    private async writeEdits(
        edits: ReturnType<AgentHookAdapter['render']>,
        targetById: ReadonlyMap<string, AgentHookConfigTarget>,
    ): Promise<void> {
        /**
         * Adapter edits are an ordered transaction plan; parallel replacement could expose a
         * mixed provider configuration or overwrite a later edit to the same target.
         */
        for (const edit of edits) {
            const target = targetById.get(edit.targetId);
            if (!target?.writable)
                throw new Error(
                    `Hook adapter attempted to write read-only target ${edit.targetId}`,
                );
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: edits must apply in order
            await atomicWrite(target.path, edit.source);
        }
    }

    private setHealth(provider: AgentProvider, health: AgentHookHealth): void {
        if (JSON.stringify(this.health[provider]) === JSON.stringify(health)) return;
        this.health = { ...this.health, [provider]: health };
        this.options.send({ event: 'agentHooks.changed', payload: this.getHealth() });
    }

    private loseAuthority(provider: AgentProvider): void {
        if (this.activeProviders.delete(provider)) this.options.onAuthorityLost(provider);
    }

    private markActive(provider: AgentProvider): void {
        if (!this.settings?.[provider].hooks.enabled) return;
        this.activeProviders.add(provider);
        this.setHealth(provider, { kind: 'active' });
    }

    private anyEnabled(): boolean {
        return agentProviderIds.some(
            (provider) => this.settings?.[provider].hooks.enabled === true,
        );
    }

    private desiredWatchTargets(
        settings: Record<AgentProvider, AgentProviderSettings>,
    ): Map<string, Set<string>> {
        const targetsByDirectory = new Map<string, Set<string>>();
        for (const provider of agentProviderIds) {
            if (!settings[provider].hooks.enabled) continue;
            const adapter = agentProviders[provider].hooks;
            if (!adapter?.supports(undefined).supported) continue;
            for (const target of adapter.configTargets(this.options.environment)) {
                const directory = dirname(target.path);
                const targets = targetsByDirectory.get(directory) ?? new Set<string>();
                targets.add(target.path);
                targetsByDirectory.set(directory, targets);
            }
        }
        return targetsByDirectory;
    }

    /**
    Watches only provider config files; Codex state/transcript churn in the same home is ignored.
     */
    private async refreshConfigWatchers(
        settings: Record<AgentProvider, AgentProviderSettings>,
    ): Promise<void> {
        const desired = this.desiredWatchTargets(settings);
        const obsoleteSubscriptions: Array<HookConfigWatcher['subscription']> = [];
        for (const [directory, watcher] of this.configWatchers) {
            const nextTargets = desired.get(directory);
            if (
                nextTargets &&
                [...nextTargets].every((target) => watcher.targets.has(target)) &&
                nextTargets.size === watcher.targets.size
            ) {
                continue;
            }
            this.configWatchers.delete(directory);
            obsoleteSubscriptions.push(watcher.subscription);
        }
        await Promise.all(obsoleteSubscriptions.map((subscription) => subscription.unsubscribe()));
        const pendingWatchers: Array<[string, Set<string>]> = [];
        for (const [directory, targets] of desired)
            if (!this.configWatchers.has(directory)) pendingWatchers.push([directory, targets]);
        /**
         * Native subscriptions for separate directories are independent; apply their results only
         * after every attempt settles so shared fallback state remains ordered.
         */
        const additions = await Promise.all(
            pendingWatchers.map(async ([directory, targets]) => {
                const targetNames = new Set([...targets].map((target) => basename(target)));
                try {
                    const subscription = await parcelWatcher.subscribe(
                        directory,
                        (error, events) => {
                            if (this.closed) return;
                            if (error) {
                                this.startConfigFallback(error);
                                return;
                            }
                            /**
                            Native macOS paths may canonicalize `/var` to `/private/var`.
                             */
                            if (events.some((event) => targetNames.has(basename(event.path))))
                                this.scheduleConfigReconcile();
                        },
                        { backend: NATIVE_WATCHER_BACKEND },
                    );
                    return { directory, subscription, targets };
                } catch (error) {
                    return { directory, error };
                }
            }),
        );
        let isWatcherFailed = false;
        for (const addition of additions) {
            if ('error' in addition) {
                isWatcherFailed = true;
                this.startConfigFallback(addition.error);
            } else {
                this.configWatchers.set(addition.directory, {
                    subscription: addition.subscription,
                    targets: addition.targets,
                });
            }
        }
        if (!isWatcherFailed && this.configWatchers.size === desired.size)
            this.stopConfigFallback();
    }

    private scheduleConfigReconcile(): void {
        if (this.closed || !this.settings) return;
        if (this.configReconcileTimer) clearTimeout(this.configReconcileTimer);
        this.configReconcileTimer = setTimeout(() => {
            this.configReconcileTimer = undefined;
            // eslint-disable-next-line no-void -- synchronous timer callback cannot await; reconcile() never rejects (errors are caught and logged internally)
            if (this.settings) void this.reconcile(this.settings);
        }, CONFIG_WATCH_SETTLE_MS);
        this.configReconcileTimer.unref();
    }

    private startConfigFallback(error: unknown): void {
        if (this.configFallbackTimer) return;
        this.options.logger.write('warn', 'agent_hooks.watcher_fallback', {
            fields: { error: errorMessage(error, 'Hook config watcher failed') },
        });
        this.configFallbackTimer = setInterval(() => {
            // eslint-disable-next-line no-void -- synchronous timer callback cannot await; reconcile() never rejects (errors are caught and logged internally)
            if (this.settings && this.anyEnabled()) void this.reconcile(this.settings);
        }, CONFIG_FALLBACK_POLL_INTERVAL_MS);
        this.configFallbackTimer.unref();
    }

    private stopConfigFallback(): void {
        if (this.configFallbackTimer) clearInterval(this.configFallbackTimer);
        this.configFallbackTimer = undefined;
    }

    private async withInstallLock<T>(operation: () => Promise<T>): Promise<T> {
        const lockPath = join(this.options.sharedPath!, 'install.lock');
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        /**
         * Lock acquisition is inherently sequential: each retry must observe the previous
         * attempt's outcome (mkdir success/EEXIST, staleness check, timeout) before deciding
         * whether to wait and retry.
         */
        while (true) {
            try {
                // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                await mkdir(lockPath);
                break;
            } catch (error) {
                if (!isFileSystemError(error, 'EEXIST')) throw error;
                try {
                    // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                    if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS)
                        // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                        await rm(lockPath, { recursive: true, force: true });
                } catch (statError) {
                    if (!isFileSystemError(statError, 'ENOENT')) throw statError;
                }
                if (Date.now() >= deadline)
                    throw new Error('Timed out waiting for the lifecycle hook install lock', {
                        cause: error,
                    });
                // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
            }
        }
        try {
            return await operation();
        } finally {
            await rm(lockPath, { recursive: true, force: true });
        }
    }

    async initialize(settings: Record<AgentProvider, AgentProviderSettings>): Promise<void> {
        this.settings = settings;
        if (!this.options.sharedPath) {
            this.health = defaultHealth('Lifecycle hook installation is unavailable in this mode.');
            return;
        }
        try {
            await mkdir(this.options.sharedPath, { recursive: true });
            this.bridgePath = await this.withInstallLock(() =>
                stageAgentHookBridge(this.options.sharedPath!),
            );
            const socketPath = join(tmpdir(), `caxri-hooks-${this.profileId}-${process.pid}.sock`);
            await pruneStaleAgentHookSockets(tmpdir(), this.profileId);
            const schemaVersions = Object.fromEntries(
                agentProviderIds.map((provider) => [
                    provider,
                    agentProviders[provider].hooks?.schemaVersion ?? 0,
                ]),
            ) as Record<AgentProvider, number>;
            this.server = new AgentHookServer(socketPath, schemaVersions, (signal) => {
                if (!this.settings?.[signal.provider].hooks.enabled) return false;
                try {
                    const isAccepted = this.options.onSignal(signal);
                    if (isAccepted) this.markActive(signal.provider);
                    return isAccepted;
                } catch (error) {
                    this.options.logger.write('warn', 'agent_hooks.signal_failed', {
                        fields: {
                            provider: signal.provider,
                            phase: signal.phase,
                            terminalId: signal.terminalId,
                            error: errorMessage(error, 'Lifecycle signal failed'),
                        },
                    });
                    return false;
                }
            });
            await this.server.start();
            await this.reconcile(settings);
        } catch (error) {
            const message = errorMessage(error, 'Lifecycle hook initialization failed');
            this.options.logger.write('warn', 'agent_hooks.initialize_failed', {
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
        this.settings = settings;
        /**
         * The queue field must be reassigned synchronously (not after an `await`) so concurrent
         * `reconcile()` calls serialize onto the same chain instead of racing to read
         * `reconcileQueue` before this call's continuation is attached.
         */
        // eslint-disable-next-line unicorn/prefer-await -- see comment above; the queue must be reassigned synchronously
        const run = this.reconcileQueue.then(() => this.reconcileNow(settings));
        // eslint-disable-next-line unicorn/prefer-await -- see comment above; the queue must be reassigned synchronously
        this.reconcileQueue = run.catch(() => {});
        return run;
    }

    terminalEnvironment(terminalId: string, provider?: AgentProvider): NodeJS.ProcessEnv {
        if (!this.server || !this.bridgePath || !this.anyEnabled()) return {};
        this.endTerminalLaunch(terminalId);
        const launchId = randomUUID();
        const token = this.server.register(terminalId, launchId, provider);
        this.terminalLaunches.set(terminalId, { launchId, token });
        this.options.onLaunchStarted(terminalId, launchId);
        return {
            CAXRI_HOOK_LAUNCH_ID: launchId,
            CAXRI_HOOK_RUNTIME: this.options.runtimeExecutable,
            CAXRI_HOOK_SOCKET: this.server.socketPath,
            CAXRI_HOOK_TERMINAL_ID: terminalId,
            CAXRI_HOOK_TOKEN: token,
        };
    }

    endTerminalLaunch(terminalId: string): void {
        const launch = this.terminalLaunches.get(terminalId);
        if (!launch) return;
        this.terminalLaunches.delete(terminalId);
        this.server?.unregister(launch.token);
        this.options.onLaunchEnded(terminalId);
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.configReconcileTimer) clearTimeout(this.configReconcileTimer);
        this.configReconcileTimer = undefined;
        this.stopConfigFallback();
        await this.reconcileQueue;
        await Promise.all(
            this.configWatchers.values().map((watcher) => watcher.subscription.unsubscribe()),
        );
        this.configWatchers.clear();
        for (const terminalId of this.terminalLaunches.keys()) this.endTerminalLaunch(terminalId);
        await this.server?.close();
        this.server = undefined;
    }
}
