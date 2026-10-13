import type { ProjectStatusRepository } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { REFRESH_ACTION_LABEL } from './status-labels';

const networkProviderListFormatter = new Intl.ListFormat('en', { type: 'conjunction' });

export type ProjectStatusFailure = ProjectStatusRepository['errors'][number];

/**
 * Failures that state one condition for the whole Project rather than a property of the repository that happened to
 * report them: a lost connection, and a provider budget the whole account shares. The root states each of these once
 * and the repository subtrees drop them, a Project holding a repository plus its submodule otherwise printed the same
 * account-level sentence twice, each with its own Refresh button.
 */
export const sharedFailureReasons = new Set<ProjectStatusFailure['reason']>([
    'network',
    'rate-limited',
]);

const providerNames = {
    acceptance: 'LobeHub',
    github: 'GitHub',
    linear: 'Linear',
    vercel: 'Vercel',
} as const satisfies Record<ProjectStatusFailure['source'], string>;

/**
 * One row for a connection every provider lost together: the user has a single thing to fix, so naming the providers
 * inside one sentence beats repeating an identical row per provider.
 */
export function networkNodes(errors: readonly ProjectStatusFailure[]): StatusNode[] {
    if (errors.length === 0) return [];
    const [first] = errors;
    const names = failureSources(errors).map((source) => providerNames[source]);
    const isShared = names.length > 1;
    return [
        item('status:network', isShared ? 'No network connection' : first.message, {
            variant: 'message',
            description: isShared
                ? `Caxri could not reach ${networkProviderListFormatter.format(names)}. Reconnect, then refresh.`
                : first.hint,
            icon: 'cloud',
            command: { command: 'caxri.project-status.refresh', title: REFRESH_ACTION_LABEL },
        }),
    ];
}

/**
 * One row per rate-limited provider, rather than one row for all of them: each budget resets on its own schedule, and
 * the Server already wrote that provider's deadline into its hint. Grouping them would have to drop the one fact that
 * makes the row worth reading.
 */
export function rateLimitNodes(errors: readonly ProjectStatusFailure[], now: number): StatusNode[] {
    const bySource = new Map<ProjectStatusFailure['source'], ProjectStatusFailure>();
    for (const error of errors) if (!bySource.has(error.source)) bySource.set(error.source, error);
    return [...bySource]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([source, error]) => {
            /**
             * Caxri honours this pause itself and recovers without the user, so inside the window there is nothing to
             * offer: Refresh would spend a click on a request the limiter answers with this very error. Past the
             * deadline, or with no deadline at all, the action comes back.
             */
            const isPaused = error.retryAt !== undefined && error.retryAt > now;
            return item(`status:rate-limit:${source}`, error.message, {
                variant: 'message',
                description: error.hint,
                icon: 'hourglass',
                ...(!isPaused && {
                    command: {
                        command: 'caxri.project-status.refresh',
                        title: REFRESH_ACTION_LABEL,
                    },
                }),
            });
        });
}

function failureSources(
    errors: readonly ProjectStatusFailure[],
): Array<ProjectStatusFailure['source']> {
    return [...new Set(errors.map((error) => error.source))].toSorted((a, b) => a.localeCompare(b));
}
