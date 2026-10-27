/**
 * A single registry point for every Renderer periodic poll (React Query `refetchInterval` reads and the standalone
 * Process Explorer window's `setInterval`-driven sampling). Two problems this collapses:
 *
 * 1. Polls used to run even while the window was hidden or backgrounded, wasting the IPC round trip and whatever the Main
 *    process spawns to answer it (e.g. `terminal.resources`'s `ps` call). Every poll registered here pauses while
 *    `document.visibilityState !== 'visible'` and fires one immediate refresh the moment the document becomes visible
 *    again, instead of waiting out a stale interval tick.
 * 2. There was no single place to see what is polling, at what interval, and why. {@link getActivePolls} is a read-only
 *    snapshot of every currently active poll, meant for debugging/monitoring (e.g. a future diagnostics panel or an ad
 *    hoc `getActivePolls()` call from devtools).
 */

/**
 * A read-only snapshot of one active poll: `label` explains what it is polling and why (surfaced verbatim from the
 * registering call site), `intervalMs` is the configured interval while visible.
 */
export interface ActivePollSnapshot {
    readonly id: number;
    readonly label: string;
    readonly intervalMs: number;
}

const activePolls = new Map<number, ActivePollSnapshot>();

/**
 * Monotonically increasing poll id. Wrapped in a mutable object (rather than a top-level `let`) so allocating the next
 * id stays a property mutation inside {@link registerPoll} instead of a top-level variable reassignment.
 */
const nextPollIdState = { current: 0 };

/**
 * Registers a poll in the module-level registry and returns its id. Callers must pair this with {@link unregisterPoll}
 * (typically in a `useEffect` cleanup or a `dispose()` method) once the poll stops.
 */
export function registerPoll(label: string, intervalMs: number): number {
    const id = nextPollIdState.current;
    nextPollIdState.current += 1;
    activePolls.set(id, { id, label, intervalMs });
    return id;
}

/**
 * Removes a poll registered by {@link registerPoll}. A no-op if `id` is already unregistered, so cleanup paths never
 * need to guard against double-invocation.
 */
export function unregisterPoll(id: number): void {
    activePolls.delete(id);
}

/**
 * Read-only snapshot of every currently registered poll, for debugging/monitoring and tests. Returns a fresh array each
 * call so callers cannot mutate the live registry.
 */
export function getActivePolls(): readonly ActivePollSnapshot[] {
    return Array.from(activePolls.values());
}

/**
 * Lowest cap the E2E seam accepts. Below a second a workflow would spend its time re-issuing requests rather than
 * exercising the behaviour under test.
 */
const MIN_E2E_MAX_POLL_INTERVAL_MS = 1_000;
/**
 * Highest cap the E2E seam accepts. The product cadences it exists to shorten are 60s, so a cap at or above that would
 * silently be a no-op instead of an override.
 */
const MAX_E2E_MAX_POLL_INTERVAL_MS = 30_000;

/**
 * Parses the `CAXRI_E2E_MAX_POLL_INTERVAL_MS` value the E2E preload bridge forwards verbatim. Fails closed on anything
 * outside the bound so a typo shortens nothing silently. `undefined` means "no cap", which is every production launch
 * and every E2E launch that did not opt in.
 */
export function parseE2EMaxPollIntervalMs(source: string | undefined): number | undefined {
    if (source === undefined) return;
    const bounds = `CAXRI_E2E_MAX_POLL_INTERVAL_MS must be an integer from ${MIN_E2E_MAX_POLL_INTERVAL_MS} to ${MAX_E2E_MAX_POLL_INTERVAL_MS}`;
    if (!/^[1-9]\d*$/u.test(source)) throw new Error(bounds);
    const cap = Number(source);
    if (
        !Number.isSafeInteger(cap) ||
        cap < MIN_E2E_MAX_POLL_INTERVAL_MS ||
        cap > MAX_E2E_MAX_POLL_INTERVAL_MS
    )
        throw new Error(bounds);
    return cap;
}

/**
 * Caps a configured cadence for focused Electron coverage that has to observe a poll actually firing.
 *
 * Several product cadences are minutes-scale on purpose (`projectStatus.overview` is a low-frequency fallback behind
 * Server-pushed invalidation, see `invalidateProjectStatusQuery` and `invalidateSessionPullRequestDependentQueries` in
 * `queries/invalidation.ts`, and `session.pullRequests` polls once a minute). A workflow proving that an availability
 * indicator recovers once the underlying CLI works again has to wait out one whole tick, which cost `pr-unknown.e2e.ts`
 * a full minute on the single-worker CI pool. The cap is opt-in per launch through `CAXRI_E2E_MAX_POLL_INTERVAL_MS` and
 * only ever lowers a cadence, so a spec asserting a fast cadence, the Logs panel's one-second tick, is unaffected
 * whether or not its launch opts in. Production never exposes the bridge and therefore never has a cap.
 */
export function resolvePollIntervalMs(intervalMs: number): number {
    const cap = parseE2EMaxPollIntervalMs(
        (globalThis as { caxriE2E?: { maxPollIntervalMs?: string } }).caxriE2E?.maxPollIntervalMs,
    );
    return cap === undefined ? intervalMs : Math.min(intervalMs, cap);
}

/**
 * The `refetchInterval` a polled query runs on: none while disabled, paused by its caller, or in a hidden document.
 */
export function resolveRefetchInterval(state: {
    enabled: boolean;
    intervalMs: number;
    isPaused: boolean;
    isVisible: boolean;
}): number | false {
    return state.enabled && !state.isPaused && state.isVisible ? state.intervalMs : false;
}

/**
 * `true` when the document is visible (or when running outside a DOM, e.g. a unit test with no `document` stub) so
 * callers default to "visible" rather than silently never polling.
 */
export function isDocumentVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * Subscribes to `document.visibilitychange` and reports the resulting visibility as a boolean, so callers never need to
 * re-read `document.visibilityState` themselves. Returns an unsubscribe function.
 */
export function subscribeVisibility(onChange: (isVisible: boolean) => void): () => void {
    const handleVisibilityChange = (): void => onChange(isDocumentVisible());
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
}

/**
 * A visibility-aware poll created by {@link createVisibilityAwarePoll}.
 */
export interface VisibilityAwarePoll {
    /**
     * Stops the interval, unsubscribes from visibility changes, and unregisters from the poll registry.
     */
    dispose(): void;
}

/**
 * Runs `callback` on a fixed `intervalMs` cadence, registered under `label` in the shared poll registry, while the
 * document is visible. The interval is torn down the moment the document becomes hidden and `callback` fires
 * immediately (in addition to restarting the interval) the moment the document becomes visible again: the same "pause
 * while hidden, refresh once on resume" contract `usePolledQuery` gives React Query callers, for call sites that poll
 * outside React Query (e.g. the standalone Process Explorer window sampling `processExplorer.snapshot()`).
 */
export function createVisibilityAwarePoll(
    label: string,
    configuredIntervalMs: number,
    callback: () => void,
): VisibilityAwarePoll {
    const intervalMs = resolvePollIntervalMs(configuredIntervalMs);
    const id = registerPoll(label, intervalMs);
    let timer: ReturnType<typeof setInterval> | undefined;

    const stopTimer = (): void => {
        if (timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
    };
    const startTimer = (): void => {
        if (timer !== undefined) return;
        timer = setInterval(callback, intervalMs);
    };

    if (isDocumentVisible()) startTimer();

    const unsubscribeVisibility = subscribeVisibility((isVisible) => {
        if (isVisible) {
            callback();
            startTimer();
        } else {
            stopTimer();
        }
    });

    return {
        dispose(): void {
            stopTimer();
            unsubscribeVisibility();
            unregisterPoll(id);
        },
    };
}
