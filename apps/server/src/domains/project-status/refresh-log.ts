import type { ProjectStatusRepository } from '@caxri/protocol';

import { countFields } from '../log-count-fields';

type RefreshResult = 'success' | 'prerequisite' | 'failure';

const CONFIRMED_PUBLICATION_STATES = new Set([
    'published',
    'synced',
    'ahead',
    'behind',
    'diverged',
]);

/**
 * Classifies a refresh by the errors its repositories carry, with one counter per `source` and `reason ?? kind`
 * (`errorVercelPrerequisite`, `errorLinearTls`). Production logged 14% of refreshes as a bare `failure` with no way to
 * tell which provider failed or whether it was only a steady missing prerequisite (an unlinked Vercel project).
 * Prerequisites alone are `prerequisite`: they describe the machine and repeat every poll until fixed.
 */
export function summarizeRefreshErrors(repositories: readonly ProjectStatusRepository[]): {
    result: RefreshResult;
    counts: Map<string, number>;
} {
    const counts = new Map<string, number>();
    let hasFailure = false;
    for (const repo of repositories)
        for (const error of repo.errors) {
            if (error.kind === 'failure') hasFailure = true;
            const cause = (error.reason ?? error.kind).replaceAll(/-(\w)/g, (_, letter: string) =>
                letter.toUpperCase(),
            );
            const key = `${error.source}${cause[0].toUpperCase()}${cause.slice(1)}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    if (hasFailure) return { result: 'failure', counts };
    return { result: counts.size > 0 ? 'prerequisite' : 'success', counts };
}

/**
 * The `project_status.refresh` record for one completed refresh. Only a real failure is `warn`; a missing prerequisite
 * is `info` so the warning stream stays a list of things that went wrong.
 */
export function refreshLogRecord(
    repositories: readonly ProjectStatusRepository[],
    ttlMs: number,
): { level: 'info' | 'warn'; fields: Record<string, number | string> } {
    const { result, counts } = summarizeRefreshErrors(repositories);
    const publicationCount = (isCounted: (state: string | undefined) => boolean) =>
        repositories.filter((repo) => isCounted(repo.publication?.state)).length;
    return {
        level: result === 'failure' ? 'warn' : 'info',
        fields: {
            repositories: repositories.length,
            result,
            ttlMs,
            ...countFields('error', counts),
            publicationConfirmed: publicationCount(
                (state) => state !== undefined && CONFIRMED_PUBLICATION_STATES.has(state),
            ),
            publicationAbsent: publicationCount((state) => state === 'unpublished'),
            publicationUnknown: publicationCount((state) => state === 'unknown'),
        },
    };
}
