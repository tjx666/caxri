import type { UpdateState } from '@caxri/protocol';

/**
 * Structured-log fields for an `updates.state` transition. Error and unavailable states carry their diagnostic context
 * (`action`/`failureKind`/`reason`); without them the log record degrades to an undiagnosable `{"status":"error"}`
 * (#244). The message text is never logged: it can embed a release URL or a failed command's stderr, and diagnostics
 * bundles copy log fields verbatim, so only its length is recorded.
 */
export function updateStateLogFields(state: UpdateState): Record<string, number | string | null> {
    return {
        status: state.status,
        ...('version' in state && { version: state.version ?? null }),
        ...(state.status === 'error' && {
            action: state.action,
            failureKind: state.failureKind,
            messageLength: state.message.length,
        }),
        ...(state.status === 'unavailable' && {
            reason: state.reason,
            /**
             * A rate-limited `unavailable` is a wait, not a fault. Recording the deadline as well is what makes "how
             * long was update discovery actually paused" answerable from logs nobody filed a bug about.
             */
            retryAt: state.retryAt === undefined ? null : new Date(state.retryAt).toISOString(),
        }),
    };
}
