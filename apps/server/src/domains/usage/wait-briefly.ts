import { setTimeout as delay } from 'node:timers/promises';

/**
 * How long a report waits for a running scan before answering with what is already stored. A first scan of years of
 * transcripts (after an upgrade that changes what an aggregate holds, every transcript) takes about a minute and would
 * outlast the Client's request timeout; later ones only stat files and finish well inside this budget.
 */
const REPORT_SCAN_WAIT_MS = 1_000;
/**
 * Settles when `task` does or after {@link REPORT_SCAN_WAIT_MS}, whichever is first; the task keeps running.
 */
export async function waitBriefly(task: Promise<unknown>): Promise<void> {
    const abort = new AbortController();
    const settle = async (promise: Promise<unknown>) => {
        try {
            await promise;
        } catch {
            // A failed scan or the cancelled timer only ends the wait; the next report retries the scan.
        }
    };
    await Promise.race([
        settle(task),
        settle(delay(REPORT_SCAN_WAIT_MS, undefined, { signal: abort.signal })),
    ]);
    abort.abort();
}
