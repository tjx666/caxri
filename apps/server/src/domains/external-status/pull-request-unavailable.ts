import type { PullRequestUnavailable } from '@caxri/protocol';

import { retryTimeLabel } from '../retry-time';
import { ExternalStatusCliError, failureReason } from './command';

/**
 * Only closed reasons and fixed recovery copy cross to the Renderer; CLI stderr can contain private repository data.
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
    const retryTime =
        reason === 'rate-limited' && error instanceof ExternalStatusCliError
            ? retryTimeLabel(error.retryAt)
            : undefined;
    const hint: Record<PullRequestUnavailable['reason'], string> = {
        'not-found': 'GitHub CLI is not installed. Install gh, then refresh.',
        // A `GH_TOKEN` environment variable authenticates the user's own shell but never reaches this CLI: Caxri's
        // external commands run on an allowlisted environment that excludes every application credential (issue
        // caxri#1345). Naming that gap keeps this from reading as "you were never signed in" to a user who is.
        'not-logged-in':
            'GitHub CLI is not signed in. Run gh auth login, then refresh. A GH_TOKEN environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
        'not-linked':
            'GitHub CLI is not configured for this repository. Check gh auth status, then refresh.',
        'permission-denied':
            'GitHub denied access to this repository. Run gh auth refresh, authorize SSO for the organization if it requires it, then refresh.',
        'rate-limited': retryTime
            ? `GitHub API rate limit reached. Caxri retries after ${retryTime}.`
            : 'GitHub API rate limit reached. Refresh after the limit resets.',
        'timeout': 'GitHub CLI timed out. Check the connection, then refresh.',
        'network': 'GitHub is unreachable. Check the connection, then refresh.',
        'tls': 'GitHub secure connection failed. Check proxy or certificates, then refresh.',
        'other': 'Could not check pull requests. Open Logs for details, then refresh.',
    };
    return { reason, hint: hint[reason] };
}
