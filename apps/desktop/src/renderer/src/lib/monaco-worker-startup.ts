/**
 * Tracks whether a Worker supplied to Monaco has answered. The historical incident included a live debugger target
 * whose module body had not executed, but this passive watcher observes replies and cannot establish that cause.
 */
type EditorWorkerStartup = 'started' | 'pending' | 'stalled';

/**
 * A missing first reply is a stall signal, not proof that the script never ran. A debugger can pause startup and later
 * resume it, so a late first reply must retire the stall before Retry can terminate the now-healthy Worker.
 */
const STARTUP_TIMEOUT_MS = 5_000;

interface TrackedWorker {
    worker: Worker;
    label: string;
    startup: EditorWorkerStartup;
    timer: ReturnType<typeof setTimeout> | undefined;
}

const state = {
    created: 0,
    started: 0,
    stalled: 0,
    recovered: 0,
    tracked: new Set<TrackedWorker>(),
};

/**
 * Per-lifetime aggregates read by the diff stall diagnostic. `created` that keeps growing while `started` does not is
 * the signature of the failure above: Monaco kept asking for Workers and none of them answered.
 */
export interface EditorWorkerStartupSummary {
    created: number;
    started: number;
    stalled: number;
    recovered: number;
    /**
     * Workers currently known to have missed their startup budget and not yet been released. A non-zero value is what
     * lets a stalled diff distinguish missing Worker replies from a comparison taking longer than its budget.
     */
    stalledNow: number;
}

export function editorWorkerStartupSummary(): EditorWorkerStartupSummary {
    let stalledNow = 0;
    for (const tracked of state.tracked) if (tracked.startup === 'stalled') stalledNow += 1;
    return {
        created: state.created,
        started: state.started,
        stalled: state.stalled,
        recovered: state.recovered,
        stalledNow,
    };
}

/**
 * Kept for the diff stall diagnostic's `editorWorkersCreated` field, whose contract is the count of Workers this window
 * handed to Monaco.
 */
export function editorWorkersCreated(): number {
    return state.created;
}

function release(tracked: TrackedWorker): void {
    if (tracked.timer !== undefined) clearTimeout(tracked.timer);
    tracked.timer = undefined;
    state.tracked.delete(tracked);
}

/**
 * Watches one Worker's startup without changing anything about it.
 *
 * The first message of any kind is proof the script ran: Monaco's Worker bootstrap installs its `onmessage` at the top
 * of the module body, so an answer can only come from a Worker that executed. Listening is deliberately passive:
 * `addEventListener` alongside Monaco's own handler, never `onmessage`, which Monaco owns and would lose.
 *
 * @returns The same Worker, so this can wrap a `MonacoEnvironment.getWorker` return value in place.
 */
export function monitorEditorWorkerStartup(worker: Worker, label: string): Worker {
    state.created += 1;
    const tracked: TrackedWorker = { worker, label, startup: 'pending', timer: undefined };
    state.tracked.add(tracked);
    const onFirstMessage = (): void => {
        if (!state.tracked.has(tracked)) return;
        tracked.startup = 'started';
        state.started += 1;
        release(tracked);
    };
    worker.addEventListener('message', onFirstMessage, { once: true });
    tracked.timer = setTimeout(() => {
        if (tracked.startup !== 'pending') return;
        tracked.startup = 'stalled';
        state.stalled += 1;
    }, STARTUP_TIMEOUT_MS);
    return worker;
}

/**
 * `ErrorEvent` carries the message a handler may read, but the event itself is what a Worker owner acts on. A runtime
 * without the richer constructor still gets a dispatched `error`, because losing the signal entirely would leave Monaco
 * waiting on a Worker this module just terminated.
 */
function createWorkerErrorEvent(): Event {
    try {
        return new ErrorEvent('error', { message: 'caxri: editor worker did not answer' });
    } catch {
        return new Event('error');
    }
}

/**
 * Releases every Worker that missed its startup budget, and tells Monaco each one is gone.
 *
 * Terminating alone does not recover anything: Monaco is waiting on a reply, and a terminated Worker is exactly as
 * silent as a stalled one. The `error` event is the part Monaco can act on: it is the only signal a Worker owner has
 * for "this Worker will not answer", and it is dispatched on the Worker itself so Monaco's own handler receives it
 * through the listener it already registered. Terminating afterwards releases the thread.
 *
 * @returns How many stalled Workers were released, so a caller can tell a real recovery attempt from a no-op.
 */
export function releaseStalledEditorWorkers(): number {
    let released = 0;
    for (const tracked of state.tracked) {
        if (tracked.startup !== 'stalled') continue;
        released += 1;
        state.recovered += 1;
        release(tracked);
        tracked.worker.dispatchEvent(createWorkerErrorEvent());
        tracked.worker.terminate();
    }
    return released;
}

/**
 * Test seam: the module-level aggregates are per-window by design, so a test that asserts on them has to start from a
 * known state.
 */
export function resetEditorWorkerStartupForTests(): void {
    for (const tracked of state.tracked) release(tracked);
    state.created = 0;
    state.started = 0;
    state.stalled = 0;
    state.recovered = 0;
}
