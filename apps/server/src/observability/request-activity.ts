import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * A request that finished recently enough to still explain an event-loop stall: a synchronous handler that blocked the
 * loop has already returned by the time the monitor's late timer fires.
 */
interface FinishedRequest {
    durationMs: number;
    endedAt: number;
    method: string;
}

interface RunningRequest {
    id: string;
    method: string;
    startedAt: number;
}

/**
 * Content-free summary of what the Server process was doing, shaped as flat log fields.
 */
export interface RequestActivitySummary {
    /**
     * `method=ms` pairs for requests that finished inside the window, longest first.
     */
    finished: string;
    /**
     * `method=ms` pairs for requests still running, longest first, with the elapsed milliseconds so far.
     */
    inFlight: string;
    inFlightCount: number;
}

const RECENT_CAPACITY = 128;
const REPORTED_REQUESTS = 5;

/**
 * Remembers which domain requests are running and which finished moments ago, so a diagnostic that fires without a
 * request of its own (an event-loop stall, a slow Git child) can name the methods that were active. It stores method
 * names, ids, and monotonic timestamps only. `begin` and the returned `end` are O(1), and the finished ring is
 * bounded.
 */
export class RequestActivityTracker {
    private readonly finished: FinishedRequest[] = [];
    private readonly running = new Map<symbol, RunningRequest>();
    /**
     * The method of the request whose async context the caller runs in. It stays readable after the request settled, so
     * work the handler left running in the background (a Git refresh after `git.summary` returned) is still
     * attributed.
     */
    private readonly callers = new AsyncLocalStorage<{ id: string; method: string }>();

    constructor(private readonly now: () => number = () => performance.now()) {}

    /**
     * Marks `method` as running under `id`. Call the returned function once when the handler settles. Entries are keyed
     * by an internal token, not `id`, because nested domain operations of one control request share its id.
     */
    begin(id: string, method: string): () => void {
        const startedAt = this.now();
        const token = Symbol(id);
        this.running.set(token, { id, method, startedAt });
        return () => {
            if (!this.running.delete(token)) return;
            const endedAt = this.now();
            this.finished.push({ method, endedAt, durationMs: endedAt - startedAt });
            if (this.finished.length > RECENT_CAPACITY) this.finished.shift();
        };
    }

    /**
     * Runs `action` with `method` attached to the async context under `id`, so background work started by the handler
     * and outliving it can still name its caller through {@link methodOf}.
     */
    runAs<Result>(id: string, method: string, action: () => Result): Result {
        return this.callers.run({ id, method }, action);
    }

    /**
     * The method of the request behind a diagnostic that only knows the request id from its observation context: the
     * one carried by the async context when it is for `id` (it outlives the request), else a request running now.
     */
    methodOf(id: string | undefined): string | undefined {
        if (id === undefined) return undefined;
        const carried = this.callers.getStore();
        if (carried?.id === id) return carried.method;
        let method: string | undefined;
        for (const request of this.running.values()) if (request.id === id) method = request.method;
        return method;
    }

    /**
     * Summarizes activity over the trailing `windowMs`. A request that started before the window but is still running
     * is included, because a long handler is the most likely owner of the stall.
     */
    summarize(windowMs: number): RequestActivitySummary {
        const now = this.now();
        const windowStart = now - windowMs;
        const inFlight = this.running
            .values()
            .map((request) => ({ method: request.method, ms: now - request.startedAt }))
            .toArray()
            .toSorted((left, right) => right.ms - left.ms);
        const finished = this.finished
            .filter((request) => request.endedAt >= windowStart)
            .map((request) => ({ method: request.method, ms: request.durationMs }))
            .toSorted((left, right) => right.ms - left.ms);
        return {
            finished: formatRequests(finished),
            inFlight: formatRequests(inFlight),
            inFlightCount: inFlight.length,
        };
    }
}

function formatRequests(requests: Array<{ method: string; ms: number }>): string {
    return requests
        .slice(0, REPORTED_REQUESTS)
        .map((request) => `${request.method}=${Math.round(request.ms)}`)
        .join(',');
}

/**
 * The process-wide tracker: the domain dispatcher writes it and the event-loop monitor and Git command log read it.
 */
export const requestActivity = new RequestActivityTracker();
