/**
 * Commit-following mode for `watch-ci.ts --sha <commit>`. A merged release is three runs on one commit: the Guards and
 * CI runs started by the push, then the "Release macOS" run that `.github/workflows/release.yml` starts through `on:
 * workflow_run` once CI completes. That last run does not exist when the watcher starts, so this module lists every run
 * of the commit repeatedly, hands each new run to the caller's single-run watcher (the shared poller, notification, and
 * backoff machinery in `watch-ci.ts`), and keeps waiting while a `workflow_run` downstream of a finished run has not
 * appeared yet.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { execFileAsync } from './exec';

const POLL_INTERVAL_MS = 15_000;
/**
 * How long a head may go without any run before the watcher gives up; GitHub normally creates runs within a minute.
 */
const RUN_START_TIMEOUT_MS = 600_000;
/**
 * How long to wait for a `workflow_run` downstream to appear after the upstream run completed successfully. GitHub
 * queues the downstream run within seconds, so three minutes absorbs a slow event delivery. Past it the downstream is
 * assumed not to apply to this commit (a `branches` or `event` filter is not evaluated here) and the watcher stops
 * waiting for it instead of hanging.
 */
export const DOWNSTREAM_GRACE_MS = 180_000;
/**
 * Consecutive failed run listings tolerated before the watcher gives up, matching `watch-ci-pr.ts`.
 */
const MAX_LIST_FAILURES = 5;

const WORKFLOWS_DIRECTORY = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

/**
 * One workflow run of the followed commit, as listed by the Actions API. `completedAtMs` is when this watcher first saw
 * the run completed; it anchors the downstream grace window.
 */
export interface CommitRun {
    completedAtMs?: number;
    conclusion: string;
    id: string;
    name: string;
    status: string;
}

export type FollowStep =
    { kind: 'done' } | { kind: 'timeout' } | { kind: 'wait'; waitingFor: string[] };

function readWorkflowRunDeclaration(document: unknown): { name: string; upstream: string[] } {
    if (typeof document !== 'object' || document === null) return { name: '', upstream: [] };
    const { name, on } = document as { name?: unknown; on?: unknown };
    if (typeof name !== 'string' || typeof on !== 'object' || on === null) {
        return { name: '', upstream: [] };
    }
    const upstream = (on as { workflow_run?: { workflows?: unknown } }).workflow_run?.workflows;
    return {
        name,
        upstream: Array.isArray(upstream)
            ? upstream.filter((entry): entry is string => typeof entry === 'string')
            : [],
    };
}

/**
 * Maps an upstream workflow name to the names of workflows that declare `on: workflow_run: workflows: [upstream]`.
 * Workflow files are read as data; a file without a `name` falls back to nothing because GitHub then names the run
 * after its path, which a `workflow_run` list cannot reference reliably.
 */
export function parseWorkflowRunChains(documents: readonly unknown[]): Map<string, string[]> {
    const chains = new Map<string, string[]>();
    for (const document of documents) {
        const { name, upstream } = readWorkflowRunDeclaration(document);
        for (const upstreamName of upstream) {
            chains.set(upstreamName, [...(chains.get(upstreamName) ?? []), name]);
        }
    }
    return chains;
}

/**
 * Whether a finished run counts as success. A downstream whose jobs are all skipped (the release workflow on an
 * ordinary commit) concludes `skipped`, which means nothing was wrong.
 */
export function isSuccessfulConclusion(conclusion: string): boolean {
    return conclusion === 'success' || conclusion === 'skipped';
}

/**
 * The next step for the runs seen on the commit so far. Done needs at least one run, every run completed, and no
 * downstream of a successfully completed run still inside its grace window. A failed or cancelled upstream never waits
 * for its downstream: the overall result is already a failure.
 */
export function nextFollowStep({
    chains,
    nowMs,
    runs,
    waitedMs,
}: {
    chains: ReadonlyMap<string, readonly string[]>;
    nowMs: number;
    runs: readonly CommitRun[];
    waitedMs: number;
}): FollowStep {
    if (runs.length === 0) {
        return waitedMs >= RUN_START_TIMEOUT_MS
            ? { kind: 'timeout' }
            : { kind: 'wait', waitingFor: [] };
    }
    const waitingFor = runs.filter((run) => run.status !== 'completed').map((run) => run.name);
    const present = new Set(runs.map((run) => run.name));
    const succeeded = runs.filter(
        (run) => run.status === 'completed' && run.conclusion === 'success',
    );
    for (const run of succeeded) {
        const isInGrace = nowMs - (run.completedAtMs ?? nowMs) < DOWNSTREAM_GRACE_MS;
        const missing = (chains.get(run.name) ?? []).filter(
            (downstream) => !present.has(downstream),
        );
        if (isInGrace) waitingFor.push(...missing);
    }
    return waitingFor.length === 0 ? { kind: 'done' } : { kind: 'wait', waitingFor };
}

async function readChains(): Promise<Map<string, string[]>> {
    const files = (await readdir(WORKFLOWS_DIRECTORY)).filter((file) => /\.ya?ml$/u.test(file));
    const documents = await Promise.all(
        files.map(
            async (file) =>
                parseYaml(await readFile(join(WORKFLOWS_DIRECTORY, file), 'utf8')) as unknown,
        ),
    );
    return parseWorkflowRunChains(documents);
}

/**
 * `gh api` fills these placeholders from the checkout's repository. REST, not `gh run list`: the GraphQL budget is
 * shared by every local session.
 */
const REPOSITORY_PATH = 'repos/{owner}/{repo}';

async function ghApi(path: string, jq: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'gh',
        ['api', `${REPOSITORY_PATH}/${path}`, '--jq', jq],
        { timeout: 60_000 },
    );
    return stdout.trim();
}

/**
 * Resolves a full or abbreviated commit SHA to the full SHA through the API, which also accepts short forms, so a merge
 * commit that is not fetched locally still resolves.
 */
async function resolveCommitSha(sha: string): Promise<string> {
    const full = await ghApi(`commits/${sha}`, '.sha');
    if (!/^[0-9a-f]{40}$/u.test(full)) throw new Error(`could not resolve commit ${sha}`);
    return full;
}

async function listCommitRuns(sha: string): Promise<Array<Omit<CommitRun, 'completedAtMs'>>> {
    const output = await ghApi(
        `actions/runs?head_sha=${sha}&per_page=100`,
        '.workflow_runs[] | [.id, .name, .status, (.conclusion // "")] | @tsv',
    );
    return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [id = '', name = '', status = '', conclusion = ''] = line.split('\t', 4);
            return { conclusion, id, name, status };
        });
}

/**
 * Seams for tests and for the caller's single-run watcher; production reads GitHub and waits in real time.
 */
export interface FollowDependencies {
    chains?: ReadonlyMap<string, readonly string[]>;
    listRuns?: (sha: string) => Promise<Array<Omit<CommitRun, 'completedAtMs'>>>;
    wait?: (ms: number) => Promise<unknown>;
}

/**
 * Follows every workflow run of `sha`, including `workflow_run` downstreams that appear after an upstream completes,
 * handing each run to `isRunGood` exactly once. Returns the runs that failed; empty means every run succeeded. Throws
 * when no run ever starts or run listing keeps failing.
 */
export async function followCommit(
    sha: string,
    isRunGood: (runId: string) => Promise<boolean>,
    { chains, listRuns = listCommitRuns, wait = sleep }: FollowDependencies = {},
): Promise<CommitRun[]> {
    const resolvedChains = chains ?? (await readChains());
    const startedAt = Date.now();
    const seen = new Map<string, CommitRun>();
    const watchers = new Map<string, Promise<boolean>>();
    let failedReads = 0;
    for (;;) {
        try {
            // eslint-disable-next-line no-await-in-loop -- follow loop: each iteration observes then sleeps
            const listed = await listRuns(sha);
            failedReads = 0;
            for (const run of listed) {
                const previous = seen.get(run.id);
                const completedAtMs =
                    run.status === 'completed'
                        ? (previous?.completedAtMs ?? Date.now())
                        : undefined;
                seen.set(run.id, { ...run, completedAtMs });
                if (!watchers.has(run.id)) watchers.set(run.id, isRunGood(run.id));
            }
        } catch (error) {
            failedReads += 1;
            if (failedReads >= MAX_LIST_FAILURES) throw error;
            console.error(`run lookup failed (retrying): ${String(error)}`);
            // eslint-disable-next-line no-await-in-loop -- follow loop: fixed cadence
            await wait(POLL_INTERVAL_MS);
            continue;
        }
        const step = nextFollowStep({
            chains: resolvedChains,
            nowMs: Date.now(),
            runs: Array.from(seen.values()),
            waitedMs: Date.now() - startedAt,
        });
        if (step.kind === 'timeout') throw new Error(`no workflow run started for commit ${sha}`);
        if (step.kind === 'done') break;
        // eslint-disable-next-line no-await-in-loop -- follow loop: fixed cadence
        await wait(POLL_INTERVAL_MS);
    }
    const failed: CommitRun[] = [];
    const entries = Array.from(watchers);
    for (const [id, watcher] of entries) {
        // eslint-disable-next-line no-await-in-loop -- every listed run is already completed, so these settle at once
        if (!(await watcher)) failed.push(seen.get(id) as CommitRun);
    }
    return failed;
}

/**
 * Resolves `sha`, follows its runs with `isRunGood`, and prints each failed run by name; returns the failed runs.
 */
export async function followAndReport(
    sha: string,
    isRunGood: (runId: string) => Promise<boolean>,
): Promise<CommitRun[]> {
    const fullSha = await resolveCommitSha(sha);
    console.log(`following every workflow run of commit ${fullSha}`);
    const failed = await followCommit(fullSha, isRunGood);
    for (const run of failed) {
        console.error(`FAILED: ${run.name} (run ${run.id}): ${run.conclusion || 'failed'}`);
    }
    return failed;
}
