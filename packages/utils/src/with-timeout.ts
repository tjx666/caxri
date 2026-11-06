/**
 * Races a promise against a deadline and always clears the timer, so a settled call never keeps the event loop alive.
 * The raced promise is not cancelled; a late result or rejection is ignored.
 *
 * When the deadline passes first the call settles as the options say: `reject` rejects with the error it returns,
 * `fallback` resolves with that value, and no options resolves `undefined`.
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T | undefined>;
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    options: { reject: () => Error },
): Promise<T>;
export async function withTimeout<T, F>(
    promise: Promise<T>,
    timeoutMs: number,
    options: { fallback: F },
): Promise<T | F>;
export async function withTimeout<T, F>(
    promise: Promise<T>,
    timeoutMs: number,
    options?: { fallback?: F; reject?: () => Error },
): Promise<T | F | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<F | undefined>((resolve, reject) => {
        timer = setTimeout(() => {
            if (options?.reject) reject(options.reject());
            else resolve(options?.fallback);
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}
