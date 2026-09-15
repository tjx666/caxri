type WorkerRoundTripOutcome = 'construct-failed' | 'no-reply' | 'ok' | 'skipped' | 'worker-error';

export interface WorkerRoundTripResult {
    outcome: WorkerRoundTripOutcome;
    /**
     * Elapsed time until the reply arrived. `null` whenever no reply was observed, so a missing duration is never
     * confused with an instant one.
     */
    durationMs: number | null;
}

export interface WorkerRoundTripOptions {
    timeoutMs?: number;
    createWorker?: () => Worker;
    now?: () => number;
}

const DEFAULT_ROUND_TRIP_TIMEOUT_MS = 2_000;

/**
 * Smallest possible Worker: it echoes whatever it receives. The probe only asks whether a message can travel Renderer →
 * Worker → Renderer, so the script deliberately does no work of its own.
 */
const ECHO_WORKER_SOURCE = 'self.onmessage = (event) => postMessage(event.data);';

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
 * Answers one question: can this renderer still receive a message from a Worker?
 *
 * Monaco's diff, its language services, and every other Worker-backed feature fail identically and silently when the
 * answer is no — the request goes out, nothing comes back, and no error is raised anywhere. Diagnosing that without
 * this probe means attaching a debugger to a live window and hand-writing the same echo Worker, which is exactly how
 * the failure behind issue #962 had to be identified.
 *
 * `no-reply` therefore means something far broader than the caller's own Worker being broken, and is the signal worth
 * acting on; `ok` narrows the fault to the caller's Worker.
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
        return { outcome: 'construct-failed', durationMs: null };
    }
    try {
        return await new Promise<WorkerRoundTripResult>((resolve) => {
            const timer = setTimeout(
                () => resolve({ outcome: 'no-reply', durationMs: null }),
                timeoutMs,
            );
            const settle = (result: WorkerRoundTripResult) => {
                clearTimeout(timer);
                resolve(result);
            };
            worker.addEventListener('message', () => {
                const elapsedMs = Math.round(now() - startedAt);
                settle({ outcome: 'ok', durationMs: Math.max(0, elapsedMs) });
            });
            worker.addEventListener('error', () =>
                settle({ outcome: 'worker-error', durationMs: null }),
            );
            worker.addEventListener('messageerror', () =>
                settle({ outcome: 'worker-error', durationMs: null }),
            );
            worker.postMessage('caxri-round-trip');
        });
    } finally {
        worker.terminate();
    }
}
