/**
 * The `state.changed` reasons a Renderer command may wait for before it reports itself done. Only commands whose result
 * the user watches land, selection and the two reorder gestures, register here; everything else settles on the ordinary
 * refresh.
 */
const SESSION_COMMAND_CONVERGENCE_REASONS = [
    'session.select',
    'session.reorder',
    'session.reorderPinned',
] as const;

export type SessionCommandConvergenceReason = (typeof SESSION_COMMAND_CONVERGENCE_REASONS)[number];

export function isSessionCommandConvergenceReason(
    reason: string,
): reason is SessionCommandConvergenceReason {
    return (SESSION_COMMAND_CONVERGENCE_REASONS as readonly string[]).includes(reason);
}

const sessionCommandConvergence = {
    pending: [] as Array<{ reason: SessionCommandConvergenceReason; resolve: () => void }>,
};

/**
 * Registers before a Session command is sent, then resolves after that command's event-driven snapshot finishes. The
 * queue preserves the Runtime's serialized command order even while Preload is replaying buffered events, and keeps the
 * command path from scheduling a duplicate `app.bootstrap`.
 */
export function registerSessionCommandConvergence(reason: SessionCommandConvergenceReason): {
    cancel: () => void;
    promise: Promise<void>;
} {
    const completion = Promise.withResolvers<void>();
    const pending = { reason, resolve: completion.resolve };
    sessionCommandConvergence.pending.push(pending);
    return {
        cancel: () => {
            const index = sessionCommandConvergence.pending.indexOf(pending);
            if (index !== -1) sessionCommandConvergence.pending.splice(index, 1);
        },
        promise: completion.promise,
    };
}

export function resolveNextSessionCommandConvergence(
    reason: SessionCommandConvergenceReason,
    refresh: Promise<void>,
): void {
    const index = sessionCommandConvergence.pending.findIndex(
        (pending) => pending.reason === reason,
    );
    if (index === -1) return;
    const pending = sessionCommandConvergence.pending.splice(index, 1).at(0);
    if (!pending) return;
    // Fire-and-forget: both outcomes release the command; refreshWorkbench reports its own failure to the user.
    // eslint-disable-next-line no-void -- the registered command owns the completion promise, not this continuation
    void refresh.then(() => pending.resolve()).catch(() => pending.resolve());
}
