type WorkerRoundTripOutcome = 'construct-failed' | 'no-reply' | 'ok' | 'skipped' | 'worker-error';

/**
 * Result of the second, independent return path. `unsupported` means this renderer has no `BroadcastChannel` at all,
 * which is a different statement from the channel existing and staying silent.
 */
type WorkerBroadcastOutcome = 'no-reply' | 'ok' | 'skipped' | 'unsupported';

export interface WorkerRoundTripResult {
    outcome: WorkerRoundTripOutcome;
    /**
     * Elapsed time until the reply arrived. `null` whenever no reply was observed, so a missing duration is never
     * confused with an instant one.
     */
    durationMs: number | null;
    broadcast: WorkerBroadcastOutcome;
}

export interface WorkerRoundTripOptions {
    timeoutMs?: number;
    createWorker?: () => Worker;
    createBroadcastChannel?: (name: string) => BroadcastChannel;
    now?: () => number;
}

const DEFAULT_ROUND_TRIP_TIMEOUT_MS = 2_000;

/**
 * Smallest possible Worker: on receipt it answers twice over two independent return paths: the Worker's own port, and a
 * `BroadcastChannel`. It deliberately does no work of its own, so a missing answer can only mean the path is broken.
 */
const ECHO_WORKER_SOURCE = `self.onmessage = (event) => {
    try { new BroadcastChannel(event.data.channel).postMessage(event.data.token); } catch {}
    postMessage(event.data.token);
};`;

function createEchoWorker(): Worker {
    const url = URL.createObjectURL(new Blob([ECHO_WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    /**
     * The blob URL is released when the probe terminates the Worker, never right after the constructor: revoking there
     * races the Worker's own asynchronous script load and would report a healthy renderer as `worker-error`.
     */
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
        terminate();
        URL.revokeObjectURL(url);
    };
    return worker;
}

/**
 * Asks whether a Worker's answer can still reach this renderer, over two paths at once.
 *
 * A Worker's own port is delivered thread-to-thread inside the renderer process. A `BroadcastChannel` leaves the
 * renderer and comes back brokered by the browser process. Because the same Worker answers on both in response to the
 * same message, comparing them separates failures that otherwise look identical:
 *
 * - `ok` + `ok`: messaging is healthy; a stalled diff is then the diff computation's own problem.
 * - `no-reply` + `ok`: the Worker started, received the page's message, and answered; only the renderer-internal return
 *   path dropped it. This is the exact shape observed in issue #962, where a live window kept losing every Worker reply
 *   while timers, fetch, and same-thread ports all kept working, and only an app restart recovered it.
 * - `no-reply` + `no-reply`: the Worker never ran, or both return paths are gone.
 *
 * Without the contrast, all three collapse into a bare `no-reply` and the next occurrence again needs a debugger
 * attached to a live window.
 */
export async function probeWorkerRoundTrip(
    options: WorkerRoundTripOptions = {},
): Promise<WorkerRoundTripResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ROUND_TRIP_TIMEOUT_MS;
    const now = options.now ?? (() => Date.now());
    const startedAt = now();
    let worker: Worker;
    try {
        worker = (options.createWorker ?? createEchoWorker)();
    } catch {
        return { outcome: 'construct-failed', durationMs: null, broadcast: 'skipped' };
    }

    // A per-probe channel name keeps two concurrent probes from reading each other's answer as their own.
    const token = `caxri-round-trip-${Math.random().toString(36).slice(2)}`;
    let channel: BroadcastChannel | undefined;
    try {
        channel = (options.createBroadcastChannel ?? ((name) => new BroadcastChannel(name)))(token);
    } catch {
        channel = undefined;
    }

    /**
     * Owned outside the executor so the cleanup below can cancel a deadline that an answer already beat, without
     * `settle` and the timer having to refer to each other.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise<WorkerRoundTripResult>((resolve) => {
            let direct: Omit<WorkerRoundTripResult, 'broadcast'> | undefined;
            let isBroadcastSeen = false;
            const settle = () => {
                resolve({
                    outcome: direct?.outcome ?? 'no-reply',
                    durationMs: direct?.durationMs ?? null,
                    broadcast: channel ? (isBroadcastSeen ? 'ok' : 'no-reply') : 'unsupported',
                });
            };
            timer = setTimeout(settle, timeoutMs);
            /**
             * Both paths are observed over the same window: settling early on the first answer would report the other
             * as silent when it was merely a moment behind.
             */
            const settleWhenComplete = () => {
                if (direct && (isBroadcastSeen || !channel)) settle();
            };

            if (channel)
                channel.addEventListener('message', () => {
                    isBroadcastSeen = true;
                    settleWhenComplete();
                });
            worker.addEventListener('message', () => {
                const elapsedMs = Math.round(now() - startedAt);
                direct = { outcome: 'ok', durationMs: Math.max(0, elapsedMs) };
                settleWhenComplete();
            });
            const failDirect = () => {
                direct = { outcome: 'worker-error', durationMs: null };
                settleWhenComplete();
            };
            worker.addEventListener('error', failDirect);
            worker.addEventListener('messageerror', failDirect);
            worker.postMessage({ channel: token, token });
        });
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        worker.terminate();
        channel?.close();
    }
}
