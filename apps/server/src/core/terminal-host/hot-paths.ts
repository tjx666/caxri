import type { RemoteResizeQueue, RemoteTerminalIdentity } from './execution-contract';
import type { TerminalInputQueue } from './input-queue';

type InputQueues = ReadonlyMap<string, TerminalInputQueue<RemoteTerminalIdentity>>;
type ResizeQueues = ReadonlyMap<string, RemoteResizeQueue>;

/**
 * The in-flight input and resize drains of each Terminal: the work admitted under its current attachment that a
 * rotation or detach must let finish before Terminal Host invalidates that attachment.
 */
export function hotPathCompletions(
    inputQueues: InputQueues,
    resizeQueues: ResizeQueues,
    terminalIds: Iterable<string>,
): Array<Promise<void>> {
    const completions: Array<Promise<void>> = [];
    for (const terminalId of terminalIds) {
        const input = inputQueues.get(terminalId)?.completion;
        const resize = resizeQueues.get(terminalId)?.completion;
        if (input) completions.push(input);
        if (resize) completions.push(resize);
    }
    return completions;
}

/**
 * Re-samples because either hot path can replace a settled queue while the other remains active.
 */
export async function settleHotPaths(
    inputQueues: InputQueues,
    resizeQueues: ResizeQueues,
    terminalIds: Iterable<string>,
): Promise<void> {
    const ids = [...terminalIds];
    while (true) {
        const completions = hotPathCompletions(inputQueues, resizeQueues, ids);
        if (completions.length === 0) return;
        // eslint-disable-next-line no-await-in-loop -- Attachment rotation must include those newly admitted queues.
        await Promise.allSettled(completions);
    }
}

/**
 * Sends a Host request that invalidates an attachment or identity only after the hot-path work admitted under it has
 * settled, so it cannot overtake input or a resize the Renderer already saw accepted.
 */
export async function afterHotPaths<T>(
    completions: ReadonlyArray<Promise<void>>,
    request: () => Promise<T>,
): Promise<T> {
    await Promise.allSettled(completions);
    return request();
}
