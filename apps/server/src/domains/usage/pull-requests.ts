import { z } from 'zod';

import type { PullRequestOutcomeRow } from '../db';
import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError, isNoPullRequest } from '../external-status';

const PULL_REQUEST_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
/**
 * An open pull request is re-asked at most this often; merged and closed outcomes are final.
 */
const OPEN_REFRESH_MS = 30 * 60_000;
/**
 * A pull request GitHub no longer resolves (deleted repository, lost access) is retried rarely.
 */
const MISSING_REFRESH_MS = 7 * 24 * 3_600_000;
/**
 * One background pass fetches at most this many outcomes, so a first report over months of history spreads its `gh`
 * calls across several passes instead of bursting the shared GitHub budget.
 */
export const MAX_PULL_REQUESTS_PER_PASS = 40;
const CONCURRENCY = 3;

const pullRequestViewSchema = z.object({
    state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
    title: z.string(),
    createdAt: z.string().nullish(),
    mergedAt: z.string().nullish(),
    additions: z.number().int().nonnegative().nullish(),
    deletions: z.number().int().nonnegative().nullish(),
});

export interface PullRequestIdentity {
    owner: string;
    repo: string;
    number: number;
}

export function parsePullRequestUrl(url: string): PullRequestIdentity | undefined {
    const match = PULL_REQUEST_URL_PATTERN.exec(url);
    if (!match) return;
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function timestamp(value: string | null | undefined): number | null {
    if (!value) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
}

export function isRefreshDue(row: PullRequestOutcomeRow | undefined, now: number): boolean {
    if (!row) return true;
    if (row.state === 'open') return now - row.checkedAt >= OPEN_REFRESH_MS;
    if (row.state === 'missing') return now - row.checkedAt >= MISSING_REFRESH_MS;
    return false;
}

export type PullRequestFetchOutcome = 'fetched' | 'missing' | 'failed' | 'rate-limited';

/**
 * Fetches GitHub outcomes through the shared `gh` runner with fixed argv. A rate-limit or authentication failure ends
 * the pass early; the remaining URLs stay pending for the next one.
 */
export async function fetchPullRequestOutcomes(
    urls: readonly string[],
    runner: ExternalStatusRunner,
    cwd: string,
    save: (row: PullRequestOutcomeRow) => void,
    now: () => number,
): Promise<Record<PullRequestFetchOutcome, number>> {
    const counts: Record<PullRequestFetchOutcome, number> = {
        'fetched': 0,
        'missing': 0,
        'failed': 0,
        'rate-limited': 0,
    };
    const queue = [...urls];
    let isStopped = false;
    const worker = async () => {
        while (!isStopped) {
            const url = queue.shift();
            if (!url) return;
            const identity = parsePullRequestUrl(url);
            if (!identity) continue;
            try {
                // eslint-disable-next-line no-await-in-loop -- each worker issues one gh call at a time
                const stdout = await runner(
                    'gh',
                    [
                        'pr',
                        'view',
                        String(identity.number),
                        '--repo',
                        `${identity.owner}/${identity.repo}`,
                        '--json',
                        'state,title,createdAt,mergedAt,additions,deletions',
                    ],
                    cwd,
                );
                const view = pullRequestViewSchema.parse(JSON.parse(stdout));
                save({
                    url,
                    state:
                        view.state === 'OPEN'
                            ? 'open'
                            : view.state === 'MERGED'
                              ? 'merged'
                              : 'closed',
                    title: view.title.slice(0, 500),
                    openedAt: timestamp(view.createdAt),
                    mergedAt: timestamp(view.mergedAt),
                    additions: view.additions ?? 0,
                    deletions: view.deletions ?? 0,
                    checkedAt: now(),
                });
                counts.fetched += 1;
            } catch (error) {
                if (isNoPullRequest(error)) {
                    save({
                        url,
                        state: 'missing',
                        title: '',
                        openedAt: null,
                        mergedAt: null,
                        additions: 0,
                        deletions: 0,
                        checkedAt: now(),
                    });
                    counts.missing += 1;
                } else if (
                    error instanceof ExternalStatusCliError &&
                    (error.kind === 'rate-limited' || error.kind === 'not-logged-in')
                ) {
                    counts['rate-limited'] += 1;
                    isStopped = true;
                } else {
                    counts.failed += 1;
                }
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return counts;
}
