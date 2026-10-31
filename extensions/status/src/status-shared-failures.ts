import type { ProjectStatusRepository } from 'caxri';
import caxri, { l10n } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { refreshActionLabel } from './status-labels';
import { localizeServerStatusText } from './status-server-text';

export type ProjectStatusFailure = ProjectStatusRepository['errors'][number];

const providerListFormatters = new Map<string, Intl.ListFormat>();

/**
 * One formatter per interface language, so the provider list joins as the current language does.
 */
function providerListFormatter(language: string): Intl.ListFormat {
    let formatter = providerListFormatters.get(language);
    if (!formatter) {
        formatter = new Intl.ListFormat(language, { type: 'conjunction' });
        providerListFormatters.set(language, formatter);
    }
    return formatter;
}

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
        item(
            'status:network',
            isShared ? l10n.t('No network connection') : localizeServerStatusText(first.message),
            {
                variant: 'message',
                description: isShared
                    ? l10n.t('Caxri could not reach {providers}. Reconnect, then refresh.', {
                          providers: providerListFormatter(caxri.env.language).format(names),
                      })
                    : first.hint && localizeServerStatusText(first.hint),
                icon: 'cloud',
                command: { command: 'caxri.project-status.refresh', title: refreshActionLabel() },
            },
        ),
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
            return item(`status:rate-limit:${source}`, localizeServerStatusText(error.message), {
                variant: 'message',
                description: error.hint && localizeServerStatusText(error.hint),
                icon: 'hourglass',
                ...(!isPaused && {
                    command: {
                        command: 'caxri.project-status.refresh',
                        title: refreshActionLabel(),
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
