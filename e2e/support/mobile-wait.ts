/**
 * A bounded mobile wait that never saw its accepted state. Callers that translate the timeout into a readable cause
 * match this class, not the message, which names the wait.
 */
export class MobileWaitTimeoutError extends Error {
    override name = 'MobileWaitTimeoutError';
}

/**
 * Polls `read` until `isAccepted` holds. A timeout names `label` and the limit, so a failed scenario says which of its
 * waits gave up: a bare "timed out" once cost a whole debugging round, because the source-mapped stack pointed at a
 * comment. Keep `label` static or built from test-authored ids; never put an observed value in it, since a check id can
 * carry a file name or path from the device.
 */
export async function waitForMobile<T>(
    read: () => T | Promise<T>,
    isAccepted: (value: T) => boolean,
    timeoutMs = 30_000,
    label?: string,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    do {
        // eslint-disable-next-line no-await-in-loop -- each observation depends on the previous state transition.
        const value = await read();
        if (isAccepted(value)) return value;
        // eslint-disable-next-line no-await-in-loop -- bounded device polling avoids duplicate automation actions.
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new MobileWaitTimeoutError(
        label
            ? `Mobile Acceptance timed out after ${timeoutMs}ms waiting for ${label}`
            : `Mobile Acceptance timed out after ${timeoutMs}ms`,
    );
}
