import type { UpdateState } from '@caxri/protocol';

/**
 * Structured-log fields for an `updates.state` transition. Error and unavailable states carry their diagnostic context
 * (`action`/`message`/`reason`); without them the log record degrades to an undiagnosable `{"status":"error"}` (#244).
 */
export function updateStateLogFields(state: UpdateState): Record<string, string | null> {
    return {
        status: state.status,
        ...('version' in state && { version: state.version ?? null }),
        ...(state.status === 'error' && {
            action: state.action,
            failureKind: state.failureKind,
            message: state.message,
        }),
        ...(state.status === 'unavailable' && {
            reason: state.reason,
            /**
             * A rate-limited `unavailable` is a wait, not a fault, and the two are indistinguishable in a log record
             * that only carries the prose `reason`. Recording the deadline as well is what makes "how long was update
             * discovery actually paused" answerable from logs nobody filed a bug about.
             */
            rateLimited: String(state.rateLimited === true),
            retryAt: state.retryAt === undefined ? null : new Date(state.retryAt).toISOString(),
        }),
    };
}
