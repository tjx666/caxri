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
/**
 * Consecutive failed lookups tolerated before startup gives up. A single dropped connection (`gh api ... EOF`) used to
 * end the watcher before it ever reached a run, leaving the agent to notice and restart it by hand.
 */
const MAX_STARTUP_READ_FAILURES = 5;
/**
 * Lookups for the run that replaced a cancelled one, POLL_INTERVAL_MS apart. A replacement is normally listed already,
 * since it is what cancelled the run, so this only covers GitHub's listing lag.
 */
const SUPERSEDING_DISCOVERY_ATTEMPTS = 4;
/**
 * Bounds how many replacements one run may chain through, so a head whose runs keep being cancelled still exits.
 */
const MAX_SUPERSEDING_HOPS = 5;

/**
 * One workflow run of the pull request's head. Run IDs grow with creation time, so a higher ID is a newer run.
 */
export interface PrRun {
    event: string;
    id: string;
    name: string;
}

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

interface PrHead {
    headSha: string;
    mergeableState: string | undefined;
    runs: PrRun[];
}

async function listHeadRuns(headSha: string, workflow: string | undefined): Promise<PrRun[]> {
    const select = workflow ? ` | select(.name == ${JSON.stringify(workflow)})` : '';
    const output = await ghApi(
        `actions/runs?head_sha=${headSha}&per_page=20`,
        `.workflow_runs[]${select} | [.id, .event, .name] | @tsv`,
    );
    return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [id = '', event = '', name = ''] = line.split('\t', 3);
            return { event, id, name };
        });
}

/**
 * The pull request's current head, whether it merges into its base, and the workflow runs started for that head. REST,
 * not `gh pr view`: the GraphQL budget is shared by every local session.
 */
async function readPrHead(pr: string, workflow: string | undefined): Promise<PrHead> {
    const [headSha = '', mergeableState] = (
        await ghApi(`pulls/${pr}`, '.head.sha + " " + .mergeable_state')
    ).split(' ', 2);
    return { headSha, mergeableState, runs: await listHeadRuns(headSha, workflow) };
}

/**
 * Seams for tests; production reads GitHub and waits in real time.
 */
interface ResolveDependencies {
    readHead?: (pr: string, workflow: string | undefined) => Promise<PrHead>;
    wait?: (ms: number) => Promise<unknown>;
}

/**
 * Waits for the current head of pull request `pr` to have workflow runs, only those named `workflow` when given, and
 * returns the head and its runs. Throws when the pull request conflicts with its base or no run starts in time; a few
 * consecutive failed lookups are retried.
 */
export async function resolvePrRuns(
    pr: string,
    workflow?: string,
    { readHead = readPrHead, wait = sleep }: ResolveDependencies = {},
): Promise<{ headSha: string; runs: PrRun[] }> {
    const startedAt = Date.now();
    let previousRunIds: string[] | undefined;
    let failedReads = 0;
    for (;;) {
        let head: PrHead;
        try {
            // eslint-disable-next-line no-await-in-loop -- startup poll: each iteration observes then sleeps
            head = await readHead(pr, workflow);
            failedReads = 0;
        } catch (error) {
            failedReads += 1;
            if (failedReads >= MAX_STARTUP_READ_FAILURES) throw error;
            console.error(`run lookup failed (retrying): ${String(error)}`);
            // eslint-disable-next-line no-await-in-loop -- startup poll: fixed cadence
            await wait(POLL_INTERVAL_MS);
            continue;
        }
        const { headSha, mergeableState, runs } = head;
        const runIds = runs.map((run) => run.id);
        const step = prStartupStep({
            mergeableState,
            previousRunIds,
            runIds,
            waitedMs: Date.now() - startedAt,
        });
        if (step.kind === 'watch') return { headSha, runs };
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
        await wait(POLL_INTERVAL_MS);
    }
}

/**
 * The newest run of `run`'s workflow and event on the same head that started after it, or `undefined` when none did.
 */
export function newerSameWorkflowRun(run: PrRun, candidates: readonly PrRun[]): PrRun | undefined {
    let newest: PrRun | undefined;
    for (const candidate of candidates) {
        if (candidate.name !== run.name || candidate.event !== run.event) continue;
        if (Number(candidate.id) <= Number(newest?.id ?? run.id)) continue;
        newest = candidate;
    }
    return newest;
}

async function readRunConclusion(runId: string): Promise<string> {
    return ghApi(`actions/runs/${runId}`, '.conclusion // ""');
}

/**
 * Seams for tests; production reads GitHub and waits in real time.
 */
interface SupersedeDependencies {
    listRuns?: (headSha: string, workflow: string | undefined) => Promise<PrRun[]>;
    readConclusion?: (runId: string) => Promise<string>;
    wait?: (ms: number) => Promise<unknown>;
}

/**
 * Watches `runs` of `headSha` with `isRunGood` and returns whether each workflow's evidence succeeded. Pushing a draft
 * and then marking it ready starts every workflow twice on the same head, and `concurrency` cancels the first runs, so
 * a cancelled run is judged by the newer run of its workflow that replaced it. A cancelled run with no replacement (a
 * manual cancel) still fails, as does a replacement that fails or is cancelled without a successor of its own.
 */
export async function didPrRunsSucceed(
    headSha: string,
    runs: readonly PrRun[],
    isRunGood: (runId: string) => Promise<boolean>,
    workflow?: string,
    {
        listRuns = listHeadRuns,
        readConclusion = readRunConclusion,
        wait = sleep,
    }: SupersedeDependencies = {},
): Promise<boolean> {
    const watched = new Map<string, Promise<boolean>>();
    const watch = (runId: string): Promise<boolean> => {
        let result = watched.get(runId);
        if (!result) {
            result = isRunGood(runId);
            watched.set(runId, result);
        }
        return result;
    };
    const findReplacement = async (run: PrRun): Promise<PrRun | undefined> => {
        for (let attempt = 0; attempt < SUPERSEDING_DISCOVERY_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each listing waits for the previous one to miss
            if (attempt > 0) await wait(POLL_INTERVAL_MS);
            // eslint-disable-next-line no-await-in-loop -- see above
            const replacement = newerSameWorkflowRun(run, await listRuns(headSha, workflow));
            if (replacement) return replacement;
        }
        return;
    };
    const didEvidenceSucceed = async (run: PrRun): Promise<boolean> => {
        let current = run;
        for (let hop = 0; hop <= MAX_SUPERSEDING_HOPS; hop += 1) {
            // eslint-disable-next-line no-await-in-loop -- each hop depends on the run the previous one found
            if (await watch(current.id)) return true;
            // eslint-disable-next-line no-await-in-loop -- see above
            if (hop === MAX_SUPERSEDING_HOPS || (await readConclusion(current.id)) !== 'cancelled')
                return false;
            // eslint-disable-next-line no-await-in-loop -- see above
            const replacement = await findReplacement(current);
            if (!replacement) return false;
            console.log(
                `${current.name} (run ${current.id}) was cancelled by a newer run on the same head; following run ${replacement.id}`,
            );
            current = replacement;
        }
        return false;
    };
    const outcomes = await Promise.all(runs.map(didEvidenceSucceed));
    return outcomes.every(Boolean);
}
