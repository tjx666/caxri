import type { PullRequestUnavailable } from '@caxri/protocol';

import { ExternalStatusCliError, failureReason } from './command';

/**
 * Only the closed reason (and a rate-limit deadline) crosses to the Renderer, which owns the recovery copy so it
 * follows the interface language; CLI stderr can contain private repository data and never travels.
 */
export function pullRequestUnavailable(error: unknown): PullRequestUnavailable {
    const classified = error instanceof ExternalStatusCliError ? error.kind : failureReason(error);
    let reason: PullRequestUnavailable['reason'];
    switch (classified) {
        case 'invalid-arguments':
        case 'no-pull-request': {
            reason = 'other';
            break;
        }
        default: {
            reason = classified;
        }
    }
    /**
     * A pause Caxri is already enforcing has a deadline, and stating it is the difference between "something is wrong"
     * and "nothing is wrong, wait": the panel and the status bar both recover on their own once it passes.
     */
    const retryAt =
        reason === 'rate-limited' && error instanceof ExternalStatusCliError
            ? error.retryAt
            : undefined;
    return {
        reason,
        ...(retryAt !== undefined && Number.isFinite(retryAt) && { retryAt: Math.trunc(retryAt) }),
    };
}
