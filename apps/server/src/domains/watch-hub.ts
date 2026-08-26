import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import parcelWatcher from '@parcel/watcher';

import { NATIVE_WATCHER_BACKEND } from './native-watcher';

/**
 * Hard cap on concurrently active native subscriptions. Native watcher capacity (FSEvents streams, file descriptors) is
 * a process-wide resource; a registration beyond the cap degrades to its polling fallback instead of consuming another
 * OS watcher. Existing consumers stay far below this (config 1, hooks ≤4, files 1, git ≤16).
 */
const DEFAULT_MAX_NATIVE_SUBSCRIPTIONS = 64;
/**
 * Crossing this fraction of the native cap logs a warning once per crossing so listener growth is visible before the
 * gate starts degrading registrations.
 */
const NATIVE_PRESSURE_WARN_RATIO = 0.75;
const MAX_SNAPSHOT_LABELS = 64;

type WatchMode = 'native' | 'polling' | 'disposed';

interface WatchFallback {
    intervalMs: number;
    /**
     * Registrations sharing a `groupKey` share one fallback timer, and each tick runs a single member's `pollOnce`.
     * Members of a group must therefore provide equivalent `pollOnce` work (e.g. one reconcile pass covering every
     * watched directory), otherwise per-member work is silently skipped.
     */
    groupKey?: string;
    /**
     * Runs once before the first poll tick when this registration's fallback activates (e.g. priming signature
     * baselines). Activation failures are logged and do not prevent the poll loop from starting.
     */
    activate?: () => Promise<void> | void;
    pollOnce: () => Promise<void> | void;
}

export interface WatchRegistrationOptions {
    /**
     * Content-free diagnostic label. Labels reach diagnostics snapshots, so they must never contain user paths or other
     * Project-identifying content. Duplicate labels are allowed and aggregated in the snapshot.
     */
    label: string;
    root: string;
    ignore?: readonly string[];
    onEvents: (events: readonly parcelWatcher.Event[]) => void;
    /**
     * Server watcher errors (post-subscribe). The hub always logs them; consumers escalate by calling
     * `handle.startFallback(error)` when an errored native subscription should degrade to polling.
     */
    onError?: (error: unknown, handle: WatchHandle) => void;
    /**
     * Degraded operation when the native subscription cannot be installed (or the native gate is exhausted). A
     * registration without a fallback rethrows its subscribe failure to the caller.
     */
    fallback?: WatchFallback;
}

export interface PollerRegistrationOptions {
    /**
     * Same content-free constraint as {@link WatchRegistrationOptions.label}.
     */
    label: string;
    intervalMs: number;
    groupKey?: string;
    activate?: () => Promise<void> | void;
    pollOnce: () => Promise<void> | void;
}

export interface WatchHandle {
    readonly label: string;
    readonly mode: WatchMode;
    /**
     * Degrades this registration to its polling fallback; a no-op when already polling or disposed.
     */
    startFallback(error: unknown): void;
    dispose(): Promise<void>;
}

interface WatchHubSnapshotEntry {
    label: string;
    native: number;
    polling: number;
    eventBatches: number;
    lastEventAt?: number;
}

export interface WatchHubSnapshot {
    registrations: number;
    native: number;
    polling: number;
    gateTrips: number;
    entries: WatchHubSnapshotEntry[];
}

export interface WatchHubOptions {
    logger?: StructuredLogger;
    maxNativeSubscriptions?: number;
    /**
     * Test seam: replaces the native backend for every registration made through this hub.
     */
    subscribe?: typeof parcelWatcher.subscribe;
}

interface FallbackGroup {
    members: Set<Registration>;
    timer?: NodeJS.Timeout;
}

class Registration implements WatchHandle {
    mode: WatchMode = 'polling';
    eventBatches = 0;
    lastEventAt?: number;
    subscription?: parcelWatcher.AsyncSubscription;
    pollTimer?: NodeJS.Timeout;
    pollInFlight = false;
    fallbackActive = false;

    constructor(
        readonly label: string,
        readonly fallback: WatchFallback | undefined,
        private readonly hub: WatchHub,
    ) {}

    startFallback(error: unknown): void {
        // Server watcher callbacks are synchronous; activation continues independently after mode changes to polling.
        // eslint-disable-next-line no-void -- runtime fallback cannot block the native callback
        void this.hub.activateFallback(this, error);
    }

    dispose(): Promise<void> {
        return this.hub.disposeRegistration(this);
    }

    /**
     * Async fallback activation can yield while another caller disposes this registration.
     */
    isDisposed(): boolean {
        return this.mode === 'disposed';
    }
}

/**
 * Central registry for every filesystem watcher and intentional poller in the Server. Consumers register instead of
 * calling `@parcel/watcher` directly, which gives one place that owns the native backend selection, the
 * subscribe-failure → polling-fallback degradation, the dispose-while-subscribing race, a capacity gate on native
 * subscriptions, and a content-free diagnostics snapshot (how many listeners exist, which degraded to polling, and how
 * busy they are).
 */
export class WatchHub {
    private closed = false;
    private nativePressureWarned = false;
    private gateTrips = 0;
    private readonly registrations = new Set<Registration>();
    private readonly fallbackGroups = new Map<string, FallbackGroup>();
    private readonly logger?: StructuredLogger;
    private readonly maxNativeSubscriptions: number;
    private readonly subscribeOverride?: typeof parcelWatcher.subscribe;

    constructor(options: WatchHubOptions = {}) {
        this.logger = options.logger;
        this.maxNativeSubscriptions =
            options.maxNativeSubscriptions ?? DEFAULT_MAX_NATIVE_SUBSCRIPTIONS;
        this.subscribeOverride = options.subscribe;
    }

    /**
     * Resolved per call (not captured at construction) so tests spying on `parcelWatcher.subscribe` observe every
     * registration regardless of when the hub was constructed.
     */
    private nativeSubscribe(): typeof parcelWatcher.subscribe {
        return this.subscribeOverride ?? parcelWatcher.subscribe;
    }

    private nativeCount(): number {
        let count = 0;
        for (const entry of this.registrations) if (entry.mode === 'native') count += 1;
        return count;
    }

    private warnOnNativePressure(): void {
        const count = this.nativeCount();
        if (count < this.maxNativeSubscriptions * NATIVE_PRESSURE_WARN_RATIO) {
            this.nativePressureWarned = false;
            return;
        }
        if (this.nativePressureWarned) return;
        this.nativePressureWarned = true;
        this.logger?.write('warn', logEventCatalog.watchHub.nativePressure, {
            fields: { native: count, maximum: this.maxNativeSubscriptions },
        });
    }

    private startSoloTimer(entry: Registration): void {
        if (!entry.fallback || entry.pollTimer) return;
        entry.pollTimer = setInterval(() => this.tick(entry), entry.fallback.intervalMs);
        entry.pollTimer.unref();
    }

    private joinFallbackGroup(groupKey: string, entry: Registration): void {
        if (!entry.fallback) return;
        const group = this.fallbackGroups.get(groupKey) ?? { members: new Set() };
        this.fallbackGroups.set(groupKey, group);
        group.members.add(entry);
        if (group.timer) return;
        group.timer = setInterval(() => {
            // Any member's pollOnce covers the whole group (see WatchFallback.groupKey), so one tick runs one member.
            const member: Registration | undefined = group.members.values().next().value;
            if (member) this.tick(member);
        }, entry.fallback.intervalMs);
        group.timer.unref();
    }

    /**
     * `setInterval` callbacks are synchronous, so poll work is deliberately fire-and-forget: an in-flight guard skips
     * overlapping ticks and failures are logged rather than left as unhandled rejections.
     */
    private tick(entry: Registration): void {
        if (entry.mode !== 'polling' || entry.pollInFlight || !entry.fallback) return;
        entry.pollInFlight = true;
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see method docstring
        void Promise.resolve(entry.fallback.pollOnce())
            .catch((error: unknown) => {
                this.logger?.write('warn', logEventCatalog.watchHub.pollFailed, {
                    fields: { label: entry.label, error: errorMessage(error, 'unknown') },
                });
            })
            .finally(() => {
                entry.pollInFlight = false;
            });
    }

    private async releaseSubscription(
        subscription: parcelWatcher.AsyncSubscription,
    ): Promise<void> {
        try {
            await subscription.unsubscribe();
        } catch {
            // Releasing a dead native subscription must not mask shutdown or fallback activation.
        }
    }

    /**
     * Registers a native watch over `root`. Resolves once the subscription is live or the fallback took over; rejects
     * only when the native backend failed and no fallback exists.
     */
    async register(options: WatchRegistrationOptions): Promise<WatchHandle> {
        const entry = new Registration(options.label, options.fallback, this);
        if (this.closed) {
            entry.mode = 'disposed';
            return entry;
        }
        this.registrations.add(entry);
        if (this.nativeCount() >= this.maxNativeSubscriptions) {
            this.gateTrips += 1;
            this.logger?.write('warn', logEventCatalog.watchHub.nativeGate, {
                fields: { label: entry.label, maximum: this.maxNativeSubscriptions },
            });
            if (!options.fallback) {
                this.registrations.delete(entry);
                entry.mode = 'disposed';
                throw new CaxriError('CAPACITY', 'Native watcher capacity exhausted');
            }
            await this.activateFallback(entry, new CaxriError('CAPACITY', 'Native watcher gate'));
            return entry;
        }
        try {
            const subscription = await this.nativeSubscribe()(
                options.root,
                (error, events) => {
                    if (entry.mode === 'disposed') return;
                    if (error) {
                        this.logger?.write('warn', logEventCatalog.watchHub.watcherError, {
                            fields: {
                                label: entry.label,
                                error: errorMessage(error, 'unknown'),
                            },
                        });
                        options.onError?.(error, entry);
                        return;
                    }
                    entry.eventBatches += 1;
                    entry.lastEventAt = Date.now();
                    options.onEvents(events);
                },
                {
                    backend: NATIVE_WATCHER_BACKEND,
                    ...(options.ignore && { ignore: [...options.ignore] }),
                },
            );
            // dispose()/close() may have run while the native subscription was in flight; release the fresh
            // subscription quietly so no watcher leaks past shutdown.
            if (entry.mode === 'disposed' || !this.registrations.has(entry)) {
                await this.releaseSubscription(subscription);
                return entry;
            }
            entry.subscription = subscription;
            entry.mode = 'native';
            this.warnOnNativePressure();
        } catch (error) {
            if (entry.mode === 'disposed' || !this.registrations.has(entry)) return entry;
            this.logger?.write('warn', logEventCatalog.watchHub.subscribeFailed, {
                fields: { label: entry.label, error: errorMessage(error, 'unknown') },
            });
            if (!options.fallback) {
                this.registrations.delete(entry);
                entry.mode = 'disposed';
                throw error;
            }
            await this.activateFallback(entry, error);
        }
        return entry;
    }

    /**
     * Registers an intentional poller (a data source with no event stream) so it shares the same registry, lifecycle,
     * and diagnostics as watchers instead of holding a private `setInterval`.
     */
    registerPoller(options: PollerRegistrationOptions): WatchHandle {
        const entry = new Registration(
            options.label,
            {
                intervalMs: options.intervalMs,
                ...(options.groupKey !== undefined && { groupKey: options.groupKey }),
                ...(options.activate && { activate: options.activate }),
                pollOnce: options.pollOnce,
            },
            this,
        );
        if (this.closed) {
            entry.mode = 'disposed';
            return entry;
        }
        this.registrations.add(entry);
        // Intentional pollers expose a synchronous registration contract; activation owns its own failure handling.
        // eslint-disable-next-line no-void -- registerPoller cannot await by contract
        void this.activateFallback(entry, undefined);
        return entry;
    }

    /**
     * @internal
     */
    async activateFallback(entry: Registration, error: unknown): Promise<void> {
        if (entry.mode === 'disposed' || entry.fallbackActive || !entry.fallback) return;
        entry.fallbackActive = true;
        entry.mode = 'polling';
        if (error !== undefined)
            this.logger?.write('warn', logEventCatalog.watchHub.fallback, {
                fields: { label: entry.label, error: errorMessage(error, 'unknown') },
            });
        const subscription = entry.subscription;
        entry.subscription = undefined;
        // The native subscription already failed or is being replaced; releasing it must never block the fallback.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see comment above
        if (subscription) void this.releaseSubscription(subscription);
        const { groupKey } = entry.fallback;
        try {
            await entry.fallback.activate?.();
        } catch (activationError) {
            this.logger?.write('warn', logEventCatalog.watchHub.fallbackActivationFailed, {
                fields: {
                    label: entry.label,
                    error: errorMessage(activationError, 'unknown'),
                },
            });
        }
        if (entry.isDisposed() || this.closed) return;
        if (groupKey === undefined) this.startSoloTimer(entry);
        else this.joinFallbackGroup(groupKey, entry);
    }

    /**
     * @internal
     */
    async disposeRegistration(entry: Registration): Promise<void> {
        if (entry.mode === 'disposed') return;
        entry.mode = 'disposed';
        this.registrations.delete(entry);
        if (entry.pollTimer) clearInterval(entry.pollTimer);
        entry.pollTimer = undefined;
        const groupKey = entry.fallback?.groupKey;
        if (groupKey !== undefined) {
            const group = this.fallbackGroups.get(groupKey);
            if (group) {
                group.members.delete(entry);
                if (group.members.size === 0) {
                    if (group.timer) clearInterval(group.timer);
                    this.fallbackGroups.delete(groupKey);
                }
            }
        }
        const subscription = entry.subscription;
        entry.subscription = undefined;
        if (subscription) await this.releaseSubscription(subscription);
    }

    /**
     * Content-free listener census for diagnostics: counts and labels only, never paths.
     */
    snapshot(): WatchHubSnapshot {
        const byLabel = new Map<string, WatchHubSnapshotEntry>();
        let native = 0;
        let polling = 0;
        for (const entry of this.registrations) {
            if (entry.mode === 'native') native += 1;
            else if (entry.mode === 'polling') polling += 1;
            const aggregate = byLabel.get(entry.label) ?? {
                label: entry.label,
                native: 0,
                polling: 0,
                eventBatches: 0,
            };
            if (entry.mode === 'native') aggregate.native += 1;
            else if (entry.mode === 'polling') aggregate.polling += 1;
            aggregate.eventBatches += entry.eventBatches;
            if (
                entry.lastEventAt !== undefined &&
                (aggregate.lastEventAt === undefined || entry.lastEventAt > aggregate.lastEventAt)
            )
                aggregate.lastEventAt = entry.lastEventAt;
            byLabel.set(entry.label, aggregate);
        }
        return {
            registrations: this.registrations.size,
            native,
            polling,
            gateTrips: this.gateTrips,
            entries: byLabel
                .values()
                .toArray()
                .toSorted((left, right) => left.label.localeCompare(right.label))
                .slice(0, MAX_SNAPSHOT_LABELS),
        };
    }

    async close(): Promise<void> {
        this.closed = true;
        const entries = [...this.registrations];
        await Promise.allSettled(entries.map((entry) => this.disposeRegistration(entry)));
    }
}
