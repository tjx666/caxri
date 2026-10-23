import type { FileWatchLimitAlert } from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import parcelWatcher from '@parcel/watcher';

import { isMustRescanAdvisory, watchFailureFields, WatchLimitAlerts } from './failures';
import { withInotifyStartProbe } from './inotify-probe';
import { NATIVE_WATCHER_BACKEND } from './native-backend';
import type { WatchHubSnapshot } from './snapshot';
import { summarizeWatchRegistrations } from './snapshot';

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
/**
 * First delay before retrying a failed native subscription, doubling on each further attempt up to
 * {@link NATIVE_RETRY_MAX_DELAY_MS}. Retries never stop once fallback is active: a native failure has no signal that
 * tells the hub it is permanent (a transient FD exhaustion or a temporarily unavailable network volume can clear at any
 * time), and a capped-interval retry attempt is cheap next to leaving a Session pinned to polling forever.
 */
const NATIVE_RETRY_INITIAL_DELAY_MS = 5_000;
const NATIVE_RETRY_MAX_DELAY_MS = 300_000;
/**
 * Coalescing window for "must rescan" advisories (see {@link isMustRescanAdvisory}). It has to exceed
 * `@parcel/watcher`'s own `Debounce::MAX_WAIT_TIME` of 500ms, because writes arriving faster than its 50ms
 * `MIN_WAIT_TIME` make it force a batch out on that 500ms ceiling: a steady advisory stream for as long as the writes
 * last. Every window shorter than that ceiling forwards each advisory unchanged, which is why the 75ms Files batch and
 * the 150ms Renderer invalidation debounce downstream do not protect this path. Doubling the ceiling folds each pair of
 * forced flushes into one reconcile while capping the extra staleness a coalesced advisory can add at one second.
 */
const RESCAN_THROTTLE_MS = 1_000;

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
     * A "must rescan" advisory on an otherwise-live native subscription (see {@link isMustRescanAdvisory}). The hub
     * never calls `onError` or degrades to polling for this case; the registration stays native and the consumer should
     * perform one reconciliation pass to recover any events the advisory implies were coalesced away.
     */
    onRescan?: () => void;
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

export interface WatchHubOptions {
    logger?: StructuredLogger;
    maxNativeSubscriptions?: number;
    /**
     * Receives {@link WatchLimitAlerts}' raised and cleared alerts when a native watch degrades because of a kernel
     * limit.
     */
    onLimitAlert?: (alert: FileWatchLimitAlert) => void;
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
    /**
     * The options `register()` was called with, kept for the lifetime of the registration so a later fallback can retry
     * the same native subscription. Absent for `registerPoller()` entries, which never have a native form: that absence
     * is what tells `activateFallback` not to schedule a native-restore retry for them.
     */
    registerOptions?: WatchRegistrationOptions;
    /**
     * Bounded exponential-backoff retry of the native subscription while this registration is degraded to polling.
     */
    nativeRetryTimer?: NodeJS.Timeout;
    nativeRetryDelayMs = NATIVE_RETRY_INITIAL_DELAY_MS;
    /**
     * Open coalescing window for "must rescan" advisories. While it is set, an advisory only counts itself in
     * `rescanCoalesced`; the window's close runs the single catch-up reconcile.
     */
    rescanTimer?: NodeJS.Timeout;
    rescanCoalesced = 0;
    /**
     * Message of the newest advisory folded into the open window, so the record written when the window closes
     * describes the most recent cause rather than the one that opened it.
     */
    rescanError?: string;

    constructor(
        readonly label: string,
        readonly fallback: WatchFallback | undefined,
        private readonly hub: WatchHub,
    ) {}

    startFallback(error: unknown): void {
        // Server watcher callbacks are synchronous; activation continues independently after mode changes to polling.
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
    private readonly limitAlerts?: WatchLimitAlerts<Registration>;

    constructor(options: WatchHubOptions = {}) {
        this.logger = options.logger;
        this.maxNativeSubscriptions =
            options.maxNativeSubscriptions ?? DEFAULT_MAX_NATIVE_SUBSCRIPTIONS;
        this.subscribeOverride = options.subscribe;
        if (options.onLimitAlert) this.limitAlerts = new WatchLimitAlerts(options.onLimitAlert);
    }

    /**
     * Resolved per call (not captured at construction) so tests spying on `parcelWatcher.subscribe` observe every
     * registration regardless of when the hub was constructed.
     */
    private nativeSubscribe(): typeof parcelWatcher.subscribe {
        return withInotifyStartProbe(
            this.subscribeOverride ?? parcelWatcher.subscribe,
            () => this.nativeCount() > 0,
        );
    }

    private nativeCount(): number {
        let count = 0;
        for (const entry of this.registrations) if (entry.mode === 'native') count += 1;
        return count;
    }

    private recordWatcherCount(): void {
        this.logger?.recordMetric('watcher.count', this.registrations.size, {
            owner: 'server-core',
            phase: 'runtime',
            outcome: 'success',
        });
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
     * Leaves this registration's poll timer (solo or shared group), without touching its native subscription or mode.
     * Shared by disposal and by a successful native restore, both of which need the fallback timer stopped.
     */
    private leaveFallbackTimer(entry: Registration): void {
        if (entry.pollTimer) clearInterval(entry.pollTimer);
        entry.pollTimer = undefined;
        const groupKey = entry.fallback?.groupKey;
        if (groupKey === undefined) return;
        const group = this.fallbackGroups.get(groupKey);
        if (!group) return;
        group.members.delete(entry);
        if (group.members.size === 0) {
            if (group.timer) clearInterval(group.timer);
            this.fallbackGroups.delete(groupKey);
        }
    }

    /**
     * Schedules the next native-restore attempt at `entry.nativeRetryDelayMs`, then doubles the delay up to
     * {@link NATIVE_RETRY_MAX_DELAY_MS} for the attempt after that. A no-op while a retry is already pending, disposed,
     * or closed, and for registrations with no native form (see `Registration.registerOptions`).
     */
    private scheduleNativeRetry(entry: Registration): void {
        if (entry.isDisposed() || this.closed || !entry.registerOptions || entry.nativeRetryTimer)
            return;
        const delay = entry.nativeRetryDelayMs;
        entry.nativeRetryTimer = setTimeout(() => {
            entry.nativeRetryTimer = undefined;
            void this.attemptNativeRestore(entry);
        }, delay);
        entry.nativeRetryTimer.unref();
        entry.nativeRetryDelayMs = Math.min(delay * 2, NATIVE_RETRY_MAX_DELAY_MS);
    }

    /**
     * One bounded-backoff attempt to resubscribe a fallback-degraded registration natively. Success stops the poll
     * timer, restores `mode: 'native'`, clears `fallbackActive` (so a later real failure can degrade again), and resets
     * the backoff for next time; failure reschedules the next attempt at the (already doubled) delay.
     */
    private async attemptNativeRestore(entry: Registration): Promise<void> {
        if (entry.isDisposed() || this.closed || entry.mode !== 'polling' || !entry.registerOptions)
            return;
        const options = entry.registerOptions;
        if (this.nativeCount() >= this.maxNativeSubscriptions) {
            this.scheduleNativeRetry(entry);
            return;
        }
        try {
            const subscription = await this.attachNativeSubscription(entry, options);
            // `entry.mode`/`this.closed` can change while the native subscribe above is awaited (dispose(), close(),
            // or a concurrent fallback/restore), so this re-check must run even though the checker narrows both from
            // the guard at the top of this method.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- entry state can change during the preceding await
            if (entry.isDisposed() || this.closed || entry.mode !== 'polling') {
                await this.releaseSubscription(subscription);
                return;
            }
            this.leaveFallbackTimer(entry);
            entry.subscription = subscription;
            entry.mode = 'native';
            entry.fallbackActive = false;
            entry.nativeRetryDelayMs = NATIVE_RETRY_INITIAL_DELAY_MS;
            this.limitAlerts?.recovered(entry);
            this.warnOnNativePressure();
            this.logger?.write('info', logEventCatalog.watchHub.nativeRestored, {
                fields: { label: entry.label },
            });
        } catch {
            // The retry attempt's own failure is not user-actionable (the loop already logged the original
            // fallback); re-arming quietly avoids one warning per backoff tick while a native backend stays down.
            this.scheduleNativeRetry(entry);
        }
    }

    /**
     * Subscribes `entry` to `options.root`, classifying every runtime callback error before forwarding it: a "must
     * rescan" advisory (see {@link isMustRescanAdvisory}) never reaches `onError`, so it can never trigger a fallback
     * degradation or a caller's root-unavailable escalation. Shared by the initial `register()` attempt and by
     * {@link attemptNativeRestore}'s retry so both paths apply the same classification.
     */
    private attachNativeSubscription(
        entry: Registration,
        options: WatchRegistrationOptions,
    ): Promise<parcelWatcher.AsyncSubscription> {
        return this.nativeSubscribe()(
            options.root,
            (error, events) => {
                if (entry.mode === 'disposed') return;
                if (error) {
                    if (isMustRescanAdvisory(error)) {
                        // FSEventsBackend.cc pairs this advisory with whatever events it still captured in the same
                        // batch (see `Watcher::triggerCallbacks` in @parcel/watcher's Watcher.cc), so forward them
                        // before treating the batch as a rescan trigger instead of silently discarding real events.
                        if (events.length > 0) {
                            entry.eventBatches += 1;
                            entry.lastEventAt = Date.now();
                            options.onEvents(events);
                        }
                        this.handleRescanAdvisory(entry, options, error);
                        return;
                    }
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
    }

    /**
     * Coalesces "must rescan" advisories into at most one reconcile per {@link RESCAN_THROTTLE_MS}. The first advisory
     * reconciles immediately, so an isolated one keeps today's zero added latency; every advisory arriving while the
     * window is open is folded into a single catch-up reconcile at its close. Dropping an advisory is never an option:
     * each one means the kernel coalesced away events the consumer has not seen, but running one reconcile per advisory
     * during a `pnpm install` or a rebase spends whole seconds of Git and Files work re-deriving state that the next
     * advisory invalidates milliseconds later.
     *
     * The advisory is also no longer worth one `info` record each: a dense window used to write one per forced flush
     * for as long as the writes lasted, against a 5MB log generation. One record per reconcile carries how many
     * advisories it covers instead.
     */
    private handleRescanAdvisory(
        entry: Registration,
        options: WatchRegistrationOptions,
        error: unknown,
    ): void {
        entry.rescanError = errorMessage(error, 'unknown');
        if (entry.rescanTimer) {
            entry.rescanCoalesced += 1;
            return;
        }
        this.runRescan(entry, options, 1);
        this.openRescanWindow(entry, options);
    }

    private openRescanWindow(entry: Registration, options: WatchRegistrationOptions): void {
        if (entry.mode !== 'native' || this.closed) return;
        entry.rescanCoalesced = 0;
        entry.rescanTimer = setTimeout(() => {
            entry.rescanTimer = undefined;
            const coalesced = entry.rescanCoalesced;
            entry.rescanCoalesced = 0;
            if (coalesced === 0 || entry.mode !== 'native' || this.closed) return;
            this.runRescan(entry, options, coalesced);
            // Writes that outlast one window keep the throttle armed instead of falling back to one reconcile each.
            // Re-checked from the top because `onRescan` runs a consumer callback that may have disposed the entry.
            this.openRescanWindow(entry, options);
        }, RESCAN_THROTTLE_MS);
        entry.rescanTimer.unref();
    }

    /**
     * Disarms the coalescing window and forgets what it had folded in. Called wherever this registration stops owning
     * native reconciliation: disposal, and degradation to the polling fallback.
     */
    private closeRescanWindow(entry: Registration): void {
        if (entry.rescanTimer) clearTimeout(entry.rescanTimer);
        entry.rescanTimer = undefined;
        entry.rescanCoalesced = 0;
    }

    private runRescan(
        entry: Registration,
        options: WatchRegistrationOptions,
        advisoryCount: number,
    ): void {
        this.logger?.write('info', logEventCatalog.watchHub.rescan, {
            fields: {
                label: entry.label,
                error: entry.rescanError ?? 'unknown',
                advisoryCount,
            },
        });
        options.onRescan?.();
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
        // Kept for the registration's lifetime so a later fallback can retry this same native subscription; see
        // `Registration.registerOptions`.
        entry.registerOptions = options;
        this.registrations.add(entry);
        this.recordWatcherCount();
        if (this.nativeCount() >= this.maxNativeSubscriptions) {
            this.gateTrips += 1;
            this.logger?.write('warn', logEventCatalog.watchHub.nativeGate, {
                fields: { label: entry.label, maximum: this.maxNativeSubscriptions },
            });
            if (!options.fallback) {
                this.registrations.delete(entry);
                this.recordWatcherCount();
                entry.mode = 'disposed';
                throw new CaxriError('CAPACITY', 'Native watcher capacity exhausted');
            }
            await this.activateFallback(entry, new CaxriError('CAPACITY', 'Native watcher gate'));
            return entry;
        }
        try {
            const subscription = await this.attachNativeSubscription(entry, options);
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
                fields: { label: entry.label, ...watchFailureFields(error) },
            });
            if (!options.fallback) {
                this.registrations.delete(entry);
                this.recordWatcherCount();
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
        this.recordWatcherCount();
        // Intentional pollers expose a synchronous registration contract; activation owns its own failure handling.
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
        // The advisory that armed the window belonged to a native subscription that is now gone; the poll loop owns
        // reconciliation from here, so a window left armed would spend one more reconcile on nothing.
        this.closeRescanWindow(entry);
        if (error !== undefined) {
            this.logger?.write('warn', logEventCatalog.watchHub.fallback, {
                fields: { label: entry.label, ...watchFailureFields(error) },
            });
            this.limitAlerts?.degraded(entry, error);
        }
        const subscription = entry.subscription;
        entry.subscription = undefined;
        // The native subscription already failed or is being replaced; releasing it must never block the fallback.
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
        // Only real watch registrations (`register()`) carry `registerOptions`; a `registerPoller()` entry has no
        // native form to restore, so it never gets a retry timer.
        if (entry.registerOptions) this.scheduleNativeRetry(entry);
    }

    /**
     * @internal
     */
    async disposeRegistration(entry: Registration): Promise<void> {
        if (entry.mode === 'disposed') return;
        entry.mode = 'disposed';
        this.registrations.delete(entry);
        this.recordWatcherCount();
        if (entry.nativeRetryTimer) clearTimeout(entry.nativeRetryTimer);
        entry.nativeRetryTimer = undefined;
        this.closeRescanWindow(entry);
        this.leaveFallbackTimer(entry);
        this.limitAlerts?.recovered(entry);
        const subscription = entry.subscription;
        entry.subscription = undefined;
        if (subscription) await this.releaseSubscription(subscription);
    }

    /**
     * Content-free listener census for diagnostics: counts and labels only, never paths.
     */
    snapshot(): WatchHubSnapshot {
        return summarizeWatchRegistrations(this.registrations, this.gateTrips);
    }

    async close(): Promise<void> {
        this.closed = true;
        const entries = [...this.registrations];
        await Promise.allSettled(entries.map((entry) => this.disposeRegistration(entry)));
    }
}
