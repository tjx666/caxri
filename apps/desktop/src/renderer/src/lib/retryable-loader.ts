/**
 * Wraps a lazy `import()` so concurrent callers share one load, while a failed load is forgotten: caching the rejected
 * promise would hand every later caller the same error until the window reloaded (for example when the dev server
 * re-optimizes dependencies mid-session), so the next call after a failure starts a fresh attempt.
 */
export function retryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    const attempt = async (): Promise<T> => {
        try {
            return await load();
        } catch (error) {
            // Deferred so a `load` that throws synchronously clears the slot after the caller has stored the promise.
            queueMicrotask(() => {
                pending = undefined;
            });
            throw error;
        }
    };
    return () => {
        pending ??= attempt();
        return pending;
    };
}
