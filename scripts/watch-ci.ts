#!/usr/bin/env bun

/**
 * Cross-session GitHub Actions run watcher.
 *
 * Multiple agent sessions often need to watch the same CI run. Naive per-session `gh run watch` loops multiply GitHub
 * API usage and die on transient network loss (the operator frequently tethers, so minutes-long offline windows are
 * normal). This watcher fixes both:
 *
 * - Single-poller election: watchers of the same run share `~/.cache/caxri/ci-watch/<runId>.json` (user-level so sessions
 *   in different worktrees still converge). The process holding a fresh heartbeat polls GitHub; every other session
 *   follows the state file at zero API cost and takes over automatically when the heartbeat goes stale.
 * - Attempt fencing: a rerun keeps the run ID, so the state file records the run attempt. Each watcher polls once itself
 *   before it may follow, and never adopts a state from an attempt older than one it has seen; otherwise a watcher
 *   started right after `gh run rerun` would exit on the previous attempt's terminal state. A watcher reports the
 *   attempt it was watching: one already running when the rerun starts still exits with that attempt's conclusion, so
 *   watch the new attempt with a new watcher.
 * - Immediate failure line: the first time any job concludes failed/timed_out/cancelled the watcher prints it, without
 *   waiting for the whole run to complete. Reported jobs are recorded in the shared state so reruns and follower
 *   sessions do not repeat it.
 * - Desktop notifications: only a successful `Release macOS` run raises a macOS notification. Every other outcome is
 *   console-only, because the Agent driving the watcher acts on it and the operator asked not to be interrupted.
 * - Offline resilience: polling errors are treated as transient and retried forever with capped exponential backoff; the
 *   watcher only exits when the run reaches a terminal status.
 *
 * Usage: `bun run scripts/watch-ci.ts [--pr <number> [--workflow <name>] | --run <id> | --branch <name> | --sha
 * <commit>] [--quiet]` `--pr` waits for every workflow run of the pull request's current head (only `--workflow`'s,
 * when given) and watches them all, failing fast when the pull request conflicts with its base (GitHub then starts no
 * CI); a run cancelled by a newer run of its workflow on the same head (a push followed by marking the draft ready) is
 * judged by that newer run. Defaults to the newest run on the current git branch. `--sha` (full or abbreviated) follows
 * every workflow run of one commit to completion, including runs that only start after another run completes (`on:
 * workflow_run`, read from `.github/workflows/*.yml`): after a release PR merges, `--sha <merge commit>` covers its CI
 * run and the Release macOS run that CI triggers. A run whose jobs are all skipped counts as success, and the failed
 * runs are printed by name. A run that `cancel-in-progress` cancelled because a newer push to the branch contains this
 * commit is replaced by that push's run of the same workflow. It cannot be combined with another selector. Exits 0 when
 * every watched run succeeded, {@link UNVERIFIED_EXIT_CODE} when `--sha` found no failure but every newer run containing
 * a cancelled run was cancelled too, and 1 otherwise.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { writeJsonAtomic } from './atomic-json';
import { execFileAsync } from './exec';
import type { CliOptions } from './watch-ci-arguments';
import { parseArguments } from './watch-ci-arguments';
import { printE2EFailures } from './watch-ci-e2e-failures';
import {
    FAILURE_CONCLUSIONS,
    formatCiNotification,
    notify,
    shouldDeliverDesktopNotification,
} from './watch-ci-notification';
import { didPrRunsSucceed, resolvePrRuns } from './watch-ci-pr';
import { followAndReport, isSuccessfulConclusion } from './watch-ci-sha';

/**
 * `--sha` exit code for a commit whose cancelled runs were superseded only by runs that were cancelled too: unverified,
 * not failed, so the caller watches the next `main` run that contains it.
 */
const UNVERIFIED_EXIT_CODE = 2;
const POLL_INTERVAL_MS = 20_000;
/**
 * A heartbeat older than three poll intervals means the polling session died (or its laptop slept); the next follower
 * promotes itself. Two concurrent promotions only cost one duplicate request before the state file converges, so the
 * race is left unlocked on purpose.
 */
const HEARTBEAT_STALE_MS = POLL_INTERVAL_MS * 3;
/**
 * Outer bound on one poll. `fetchRun` gives each `gh` call a 60s `execFile` timeout, but that callback waits for the
 * child's stdio to close, so a `gh` whose descendant keeps the pipe open never settles: a watcher once stopped
 * heartbeating after its first poll and printed nothing for 30 minutes while the run completed. Both attempts in
 * `fetchRun` fit inside this deadline.
 */
const POLL_DEADLINE_MS = 150_000;
const INITIAL_BACKOFF_MS = POLL_INTERVAL_MS;
const MAX_BACKOFF_MS = 300_000;

/**
 * User-level, worktree-independent state root: parallel agent sessions usually run in different isolated worktrees, so
 * a repository-local `.cache` would silently break the single-poller election. GitHub run database IDs are globally
 * unique, so keying by run ID alone is safe.
 */
const STATE_DIRECTORY = join(homedir(), '.cache', 'caxri', 'ci-watch');

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export interface WatchedJob {
    conclusion: string;
    name: string;
    status: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export interface WatchState {
    /**
     * GitHub `run_attempt`. A rerun reuses the run ID and starts a new attempt, so a terminal status is only meaningful
     * together with the attempt it belongs to.
     */
    attempt: number;
    /**
     * Run identity shown in notifications. Each agent session owns one worktree branch, so the branch is what tells the
     * operator which session's delivery the run belongs to; the display title is the PR or commit title.
     */
    branch?: string;
    conclusion: string;
    displayTitle?: string;
    heartbeatAt: string;
    /**
     * Whether `jobs` came from this attempt's latest poll. The status-only fallback in `fetchRun` keeps the previous
     * job list for display, and that list cannot prove the jobs finished.
     */
    isJobListCurrent?: boolean;
    jobs: WatchedJob[];
    notifiedFailedJobs: string[];
    pollerPid: number;
    runId: string;
    status: string;
    url?: string;
    workflowName?: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function isHeartbeatStale(heartbeatAt: string | undefined, nowMs: number): boolean {
    if (!heartbeatAt) return true;
    const beatMs = Date.parse(heartbeatAt);
    if (Number.isNaN(beatMs)) return true;
    return nowMs - beatMs > HEARTBEAT_STALE_MS;
}

/**
 * Rejects when `work` has not settled within `ms`, so a hung child process becomes an ordinary retryable poll failure.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} did not settle within ${Math.round(ms / 1_000)}s`));
        }, ms);
    });
    try {
        return await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function nextBackoffMs(currentMs: number): number {
    return Math.min(Math.max(currentMs, INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

/**
 * Whether this watcher may take the shared state as current instead of polling GitHub itself. Before its own first poll
 * a watcher does not know the current attempt, so it cannot tell a previous attempt's terminal state from the live one;
 * a state from an attempt older than one already observed is likewise a stale write, never current.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function canFollowSharedState(
    state: WatchState | undefined,
    observedAttempt: number | undefined,
    nowMs: number,
    pid: number,
): state is WatchState {
    return (
        state !== undefined &&
        observedAttempt !== undefined &&
        state.pollerPid !== pid &&
        state.attempt >= observedAttempt &&
        !isHeartbeatStale(state.heartbeatAt, nowMs)
    );
}

/**
 * Whether the run is over. GitHub can report a run `completed` with a successful conclusion while one of its jobs is
 * still `in_progress` (PR 2798's run 40516588063 did, with `unit (1/3)` running), so a current job list must also show
 * every job completed. Without one, the run status is the only evidence left.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function isRunSettled(
    state: Pick<WatchState, 'isJobListCurrent' | 'jobs' | 'status'>,
): boolean {
    if (state.status !== 'completed') return false;
    return !state.isJobListCurrent || state.jobs.every((job) => job.status === 'completed');
}

/**
 * Jobs that newly reached a failing conclusion and have not been notified yet, in job order.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function newlyFailedJobs(alreadyNotified: string[], jobs: WatchedJob[]): string[] {
    const notified = new Set(alreadyNotified);
    return jobs
        .filter(
            (job) =>
                job.status === 'completed' &&
                FAILURE_CONCLUSIONS.has(job.conclusion) &&
                !notified.has(job.name),
        )
        .map((job) => job.name);
}

/**
 * Whether a settled run has a failed E2E job whose log carries public `test-end` events worth summarizing.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function hasFailedE2EJob(jobs: WatchedJob[]): boolean {
    return jobs.some((job) => /\be2e\b/i.test(job.name) && FAILURE_CONCLUSIONS.has(job.conclusion));
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function formatRunSummary(
    state: Pick<WatchState, 'attempt' | 'conclusion' | 'jobs' | 'runId'>,
): string {
    const run =
        state.attempt > 1 ? `run ${state.runId} (attempt ${state.attempt})` : `run ${state.runId}`;
    const lines = [`${run}: ${state.conclusion || 'in progress'}`];
    for (const job of state.jobs) {
        lines.push(`  ${job.name}: ${job.conclusion || job.status}`);
    }
    return lines.join('\n');
}

function statePath(runId: string): string {
    return join(STATE_DIRECTORY, `${runId}.json`);
}

async function readState(runId: string): Promise<WatchState | undefined> {
    try {
        return JSON.parse(await readFile(statePath(runId), 'utf8')) as WatchState;
    } catch {
        return undefined;
    }
}

/**
 * Write-then-rename keeps follower sessions from ever reading a torn JSON document.
 */
async function writeState(state: WatchState): Promise<void> {
    await writeJsonAtomic(statePath(state.runId), state, { ensureParent: true });
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export interface GhRunView {
    attempt?: number;
    conclusion?: string;
    displayTitle?: string;
    headBranch?: string;
    jobs?: Array<{ conclusion?: string; name?: string; status?: string }>;
    status?: string;
    url?: string;
    workflowName?: string;
}

async function fetchRun(runId: string): Promise<GhRunView> {
    try {
        const { stdout } = await execFileAsync(
            'gh',
            [
                'run',
                'view',
                runId,
                '--json',
                'attempt,status,conclusion,jobs,url,headBranch,displayTitle,workflowName',
            ],
            { timeout: 60_000 },
        );
        return JSON.parse(stdout) as GhRunView;
    } catch {
        // GitHub's run-jobs list endpoint (`/actions/runs/<id>/jobs`) intermittently 404s for hours while the run
        // itself stays queryable, which used to trap the watcher in an endless retry loop that never reported the
        // run's conclusion. Degrade to status-only polling: per-job early failure notifications pause, but terminal
        // success/failure detection, the watcher's core contract, keeps working.
        const { stdout } = await execFileAsync(
            'gh',
            [
                'run',
                'view',
                runId,
                '--json',
                'attempt,status,conclusion,url,headBranch,displayTitle,workflowName',
            ],
            { timeout: 60_000 },
        );
        return JSON.parse(stdout) as GhRunView;
    }
}

async function resolveRunId(branchOverride: string | undefined): Promise<string> {
    let branch = branchOverride;
    if (!branch) {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        branch = stdout.trim();
    }
    const { stdout } = await execFileAsync('gh', [
        'run',
        'list',
        '--branch',
        branch,
        '--limit',
        '1',
        '--json',
        'databaseId',
        '--jq',
        '.[0].databaseId',
    ]);
    const runId = stdout.trim();
    if (!runId) throw new Error(`no workflow runs found for branch ${branch}`);
    return runId;
}

/**
 * Folds one `gh run view` result into the shared state this process is about to publish as poller.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function buildWatchState(
    runId: string,
    view: GhRunView,
    previous: WatchState | undefined,
    poller: Pick<WatchState, 'heartbeatAt' | 'pollerPid'>,
): WatchState {
    const attempt = view.attempt ?? 1;
    // Job lists and failure notifications belong to one attempt: a rerun job that fails again must notify again.
    const isSameAttempt = previous?.attempt === attempt;
    // A missing jobs array means fetchRun fell back to status-only polling; keep the last known job list instead of
    // erasing it so the printed summary stays informative.
    const jobs: WatchedJob[] = view.jobs
        ? view.jobs.map((job) => ({
              conclusion: job.conclusion ?? '',
              name: job.name ?? 'unknown job',
              status: job.status ?? '',
          }))
        : isSameAttempt
          ? previous.jobs
          : [];
    return {
        attempt,
        branch: view.headBranch ?? previous?.branch,
        conclusion: view.conclusion ?? '',
        displayTitle: view.displayTitle ?? previous?.displayTitle,
        heartbeatAt: poller.heartbeatAt,
        isJobListCurrent: view.jobs !== undefined,
        jobs,
        notifiedFailedJobs: isSameAttempt ? previous.notifiedFailedJobs : [],
        pollerPid: poller.pollerPid,
        runId,
        status: view.status ?? '',
        url: view.url,
        workflowName: view.workflowName ?? previous?.workflowName,
    };
}

async function pollOnce(runId: string, previous: WatchState | undefined): Promise<WatchState> {
    const run = await withDeadline(fetchRun(runId), POLL_DEADLINE_MS, `gh run view ${runId}`);
    const state = buildWatchState(runId, run, previous, {
        heartbeatAt: new Date().toISOString(),
        pollerPid: process.pid,
    });
    const failedJobs = newlyFailedJobs(state.notifiedFailedJobs, state.jobs);
    if (failedJobs.length > 0) {
        state.notifiedFailedJobs = [...state.notifiedFailedJobs, ...failedJobs];
        await notify(formatCiNotification(state, failedJobs), {
            isDesktop: shouldDeliverDesktopNotification(state, failedJobs),
            url: state.url,
        });
    }
    await writeState(state);
    return state;
}

/**
 * Watches one run until it reaches a terminal status and returns whether it succeeded.
 */
async function didRunSucceed(
    runId: string,
    isQuiet: boolean,
    isSkippedSuccess = false,
): Promise<boolean> {
    console.log(`watching run ${runId} (state: ${statePath(runId)})`);

    let backoffMs = INITIAL_BACKOFF_MS;
    let lastPrinted = '';
    let observedAttempt: number | undefined;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- watch loop: each iteration observes then sleeps
        let state = await readState(runId);
        // Poll unless another live session already holds the poller role for the current attempt.
        if (!canFollowSharedState(state, observedAttempt, Date.now(), process.pid)) {
            try {
                // eslint-disable-next-line no-await-in-loop -- watch loop: polls are inherently sequential
                state = await pollOnce(runId, state);
                backoffMs = INITIAL_BACKOFF_MS;
            } catch (error) {
                // Offline or rate-limited: keep the loop alive and retry with capped backoff.
                console.error(
                    `poll failed (retrying in ${Math.round(backoffMs / 1_000)}s): ${String(error)}`,
                );
                // eslint-disable-next-line no-await-in-loop -- watch loop: backoff between retries
                await sleep(backoffMs);
                backoffMs = nextBackoffMs(backoffMs);
                continue;
            }
        }

        observedAttempt = Math.max(observedAttempt ?? 0, state.attempt);
        const summary = formatRunSummary(state);
        if (summary !== lastPrinted && !isQuiet) {
            console.log(summary);
            lastPrinted = summary;
        }
        if (isRunSettled(state)) {
            // eslint-disable-next-line no-await-in-loop -- terminal notification; the loop exits right after
            await notify(formatCiNotification(state), {
                isDesktop: shouldDeliverDesktopNotification(state),
                url: state.url,
            });
            if (hasFailedE2EJob(state.jobs))
                // eslint-disable-next-line no-await-in-loop -- terminal summary; the loop exits right after
                await printE2EFailures(runId);
            return isSkippedSuccess
                ? isSuccessfulConclusion(state.conclusion)
                : state.conclusion === 'success';
        }
        // eslint-disable-next-line no-await-in-loop -- watch loop: fixed poll cadence
        await sleep(POLL_INTERVAL_MS);
    }
}

async function main(): Promise<void> {
    let options: CliOptions;
    let runIds: string[] = [];
    try {
        options = parseArguments(process.argv.slice(2));
        if (options.sha) {
            const { failed, unverified } = await followAndReport(options.sha, (runId) =>
                didRunSucceed(runId, options.quiet, true),
            );
            process.exit(failed.length > 0 ? 1 : unverified.length > 0 ? UNVERIFIED_EXIT_CODE : 0);
        }
        if (options.pr) {
            const { headSha, runs } = await resolvePrRuns(options.pr, options.workflow);
            const succeeded = await didPrRunsSucceed(
                headSha,
                runs,
                (runId) => didRunSucceed(runId, options.quiet),
                options.workflow,
            );
            process.exit(succeeded ? 0 : 1);
        }
        runIds = [options.run ?? (await resolveRunId(options.branch))];
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    const results = await Promise.all(runIds.map((runId) => didRunSucceed(runId, options.quiet)));
    process.exit(results.every(Boolean) ? 0 : 1);
}

if (import.meta.main) {
    await main();
}
