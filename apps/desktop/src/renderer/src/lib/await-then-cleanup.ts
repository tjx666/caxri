/**
 * Awaits `work` and runs `cleanup` once it settles, whether it resolved or rejected; a rejection still propagates.
 *
 * It exists because React Compiler cannot compile a `try`/`finally` inside a component or hook, and bails out of the
 * whole function. Keeping the `finally` in this plain function lets a hook await work and release its busy flag without
 * that bailout.
 */
export async function awaitThenCleanup<T>(work: Promise<T>, cleanup: () => void): Promise<T> {
    try {
        return await work;
    } finally {
        cleanup();
    }
}

/**
 * Runs `work` and then `cleanup`, whether `work` returned or threw; a throw still propagates. The synchronous sibling
 * of `awaitThenCleanup`, for the same React Compiler reason.
 */
export function runThenCleanup<T>(work: () => T, cleanup: () => void): T {
    try {
        return work();
    } finally {
        cleanup();
    }
}
