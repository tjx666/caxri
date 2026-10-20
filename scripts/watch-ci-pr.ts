/**
 * Resolves the workflow runs of a pull request's current head for `watch-ci.ts --pr`. Right after a push GitHub has not
 * created the runs yet, and a pull request that conflicts with its base gets none at all, so this waits for the runs to
 * appear and reports a conflict instead of leaving the caller to poll for run IDs by hand.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { execFileAsync } from './exec';

const POLL_INTERVAL_MS = 15_000;
/**
 * How long a head may go without any run before the watcher gives up; GitHub normally creates runs within a minute.
 */
const RUN_START_TIMEOUT_MS = 600_000;

export type PrStartupStep =
    | { kind: 'watch'; runIds: string[] }
    | { kind: 'wait' }
    | { kind: 'conflict' }
    | { kind: 'timeout' };

/**
 * The next step for a head that has `runIds` so far. A second workflow's run can lag the first by a few seconds, so
 * runs are only taken once one poll has seen the same set (`previousRunIds`). GitHub's `mergeable_state` is `dirty`
 * when the pull request conflicts with its base, which starts no `pull_request` workflow until it is rebased.
 */

export function prStartupStep({
    mergeableState,
    previousRunIds,
    runIds,
    waitedMs,
}: {
    mergeableState: string | undefined;
    previousRunIds: readonly string[] | undefined;
    runIds: readonly string[];
    waitedMs: number;
}): PrStartupStep {
    if (runIds.length > 0) {
        const isSettled =
            previousRunIds?.length === runIds.length &&
            runIds.every((id) => previousRunIds.includes(id));
        return isSettled ? { kind: 'watch', runIds: [...runIds] } : { kind: 'wait' };
    }
    if (mergeableState === 'dirty') return { kind: 'conflict' };
    return waitedMs >= RUN_START_TIMEOUT_MS ? { kind: 'timeout' } : { kind: 'wait' };
}

/**
 * `gh api` fills these placeholders from the checkout's repository.
 */
const REPOSITORY_PATH = 'repos/{owner}/{repo}';

async function ghApi(path: string, jq: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'gh',
        ['api', `${REPOSITORY_PATH}/${path}`, '--jq', jq],
        {
            timeout: 60_000,
        },
    );
    return stdout.trim();
}

/**
 * The pull request's current head, whether it merges into its base, and the workflow runs started for that head. REST,
 * not `gh pr view`: the GraphQL budget is shared by every local session.
 */
async function readPrHead(
    pr: string,
): Promise<{ headSha: string; mergeableState: string | undefined; runIds: string[] }> {
    const [headSha = '', mergeableState] = (
        await ghApi(`pulls/${pr}`, '.head.sha + " " + .mergeable_state')
    ).split(' ', 2);
    const runIds = await ghApi(
        `actions/runs?head_sha=${headSha}&per_page=20`,
        '.workflow_runs[].id',
    );
    return { headSha, mergeableState, runIds: runIds.split('\n').filter(Boolean) };
}

/**
 * Waits for the current head of pull request `pr` to have workflow runs and returns their IDs. Throws when the pull
 * request conflicts with its base or no run starts in time.
 */

export async function resolvePrRuns(pr: string): Promise<string[]> {
    const startedAt = Date.now();
    let previousRunIds: string[] | undefined;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- startup poll: each iteration observes then sleeps
        const { headSha, mergeableState, runIds } = await readPrHead(pr);
        const step = prStartupStep({
            mergeableState,
            previousRunIds,
            runIds,
            waitedMs: Date.now() - startedAt,
        });
        if (step.kind === 'watch') return step.runIds;
        if (step.kind === 'conflict') {
            throw new Error(
                `PR #${pr} conflicts with its base branch, so GitHub starts no CI for it; rebase onto the latest base and push again`,
            );
        }
        if (step.kind === 'timeout') {
            throw new Error(`no workflow run started for PR #${pr} head ${headSha}`);
        }
        previousRunIds = runIds;
        // eslint-disable-next-line no-await-in-loop -- startup poll: fixed cadence
        await sleep(POLL_INTERVAL_MS);
    }
}
