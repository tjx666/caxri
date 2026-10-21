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
 * - Immediate failure notification: the first time any job concludes failed/timed_out/cancelled a macOS notification
 *   fires, without waiting for the whole run to complete. Notified jobs are recorded in the shared state so reruns and
 *   follower sessions do not re-notify.
 * - Offline resilience: polling errors are treated as transient and retried forever with capped exponential backoff; the
 *   watcher only exits when the run reaches a terminal status.
 *
 * Usage: `bun run scripts/watch-ci.ts [--pr <number> [--workflow <name>] | --run <id> | --branch <name>] [--quiet]`
 * `--pr` waits for every workflow run of the pull request's current head (only `--workflow`'s, when given) and watches
 * them all, failing fast when the pull request conflicts with its base (GitHub then starts no CI). Defaults to the
 * newest run on the current git branch. Exits 0 when every watched run succeeded, 1 otherwise.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from './exec';
import { resolvePrRuns } from './watch-ci-pr';

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
    jobs: WatchedJob[];
    notifiedFailedJobs: string[];
    pollerPid: number;
    runId: string;
    status: string;
    url?: string;
    workflowName?: string;
}

/**
 * Job conclusions that warrant an immediate notification while the run is still in progress.
 */
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);

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

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export interface CiNotification {
    message: string;
    subtitle?: string;
    title: string;
}

/**
 * Notification copy for a failed job or a finished run. The bare `run <id>: failure` it replaces named neither the
 * branch nor the failing job, so the operator had to open the run to learn which session broke and where.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function formatCiNotification(
    state: Pick<
        WatchState,
        'branch' | 'conclusion' | 'displayTitle' | 'jobs' | 'runId' | 'status' | 'workflowName'
    >,
    newlyFailed: string[] = [],
): CiNotification {
    const target = state.branch ?? `run ${state.runId}`;
    const subtitle = state.displayTitle;
    const workflow = state.workflowName ?? 'CI';
    const failedJobs =
        newlyFailed.length > 0
            ? newlyFailed
            : state.jobs
                  .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion))
                  .map((job) => job.name);
    const withSubtitle = (notification: CiNotification): CiNotification =>
        subtitle ? { ...notification, subtitle } : notification;
    if (
        newlyFailed.length === 0 &&
        state.status === 'completed' &&
        state.conclusion === 'success'
    ) {
        return withSubtitle({ title: `CI passed · ${target}`, message: `${workflow} succeeded` });
    }
    const outcome =
        newlyFailed.length > 0 ? 'failed' : (state.conclusion || 'failed').replaceAll('_', ' ');
    return withSubtitle({
        title: `CI failed · ${target}`,
        message:
            failedJobs.length > 0
                ? `${workflow} ${outcome}: ${failedJobs.join(', ')}`
                : `${workflow} ${outcome}`,
    });
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
    await mkdir(STATE_DIRECTORY, { recursive: true });
    const finalPath = statePath(state.runId);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, 'utf8');
    await rename(temporaryPath, finalPath);
}

/**
 * Repository icon shown on alerter notifications; resolved from the script location so worktrees work too. alerter
 * draws the image as-is, so it must be the variant with the rounded macOS plate baked in, not the full-bleed
 * `icon.png`.
 */
const APP_ICON_PATH = fileURLToPath(new URL('../build/notification-icon.png', import.meta.url));

/**
 * How long an alerter notification stays up (and the poller blocks) waiting for a click before auto-closing. Failure
 * notifications are rare, so pausing the 20s poll cadence for up to this long is an acceptable trade for
 * click-to-open.
 */
const NOTIFICATION_TIMEOUT_SECONDS = 30;

/**
 * Best-effort macOS notification. Prefers `alerter` (brew) over `osascript` because AppleScript notifications are
 * permanently branded with the Script Editor icon and cannot react to clicks; alerter shows the repository icon and
 * clicking the notification opens the run page. Falls back to `osascript` only when alerter is not installed.
 */
async function notify({ message, subtitle, title }: CiNotification, url?: string): Promise<void> {
    console.log(`${title}: ${message}`);
    if (process.platform !== 'darwin') return;
    try {
        const { stdout } = await execFileAsync('alerter', [
            '--title',
            title,
            ...(subtitle ? ['--subtitle', subtitle] : []),
            '--message',
            message,
            '--app-icon',
            APP_ICON_PATH,
            '--sound',
            'Basso',
            '--timeout',
            String(NOTIFICATION_TIMEOUT_SECONDS),
            '--json',
        ]);
        const activation = JSON.parse(stdout) as { activationType?: string };
        if (url && /clicked/iu.test(activation.activationType ?? '')) {
            await execFileAsync('open', [url]);
        }
        return;
    } catch (error) {
        // Any failure other than "alerter is not installed" still counts as attempted delivery; the console line
        // above already carries the signal.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    try {
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`;
        await execFileAsync('osascript', ['-e', script]);
    } catch {
        // Notification delivery is best-effort; the console line above already carries the signal.
    }
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

interface CliOptions {
    branch?: string;
    pr?: string;
    quiet: boolean;
    run?: string;
    /**
     * With `--pr`, watch only the runs of this workflow, such as `Guards`, the one check `main` requires.
     */
    workflow?: string;
}

const VALUE_FLAGS = new Set(['--run', '--workflow', '--pr', '--branch']);

/**
 * Returns the operand of a value flag, or throws when it is missing, blank, or another flag. Failing open here would
 * let `--branch` with no value silently watch the current branch, so every value flag shares this one check.
 */
function readOperand(flag: string, value: string | undefined): string {
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

/**
 * Applies one CLI argument and returns how many argv slots it consumed.
 */
function applyArgument(options: CliOptions, argument: string, value: string | undefined): number {
    if (argument === '--quiet') {
        options.quiet = true;
        return 1;
    }
    if (!VALUE_FLAGS.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const operand = readOperand(argument, value);
    switch (argument) {
        case '--run': {
            options.run = operand;
            break;
        }
        case '--workflow': {
            options.workflow = operand;
            break;
        }
        case '--pr': {
            options.pr = operand;
            break;
        }
        default:
            options.branch = operand;
    }
    return 2;
}

/**
 * Parses argv without touching Git, GitHub, or any process, so an invalid command line is rejected before any call.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci-arguments.test.ts
export function parseArguments(argv: string[]): CliOptions {
    const options: CliOptions = { quiet: false };
    let index = 0;
    while (index < argv.length) {
        index += applyArgument(options, argv[index], argv[index + 1]);
    }
    return options;
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
        await notify(formatCiNotification(state, failedJobs), state.url);
    }
    await writeState(state);
    return state;
}

/**
 * Watches one run until it reaches a terminal status and returns whether it succeeded.
 */
async function didRunSucceed(runId: string, isQuiet: boolean): Promise<boolean> {
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
        if (state.status === 'completed') {
            // eslint-disable-next-line no-await-in-loop -- terminal notification; the loop exits right after
            await notify(formatCiNotification(state), state.url);
            return state.conclusion === 'success';
        }
        // eslint-disable-next-line no-await-in-loop -- watch loop: fixed poll cadence
        await sleep(POLL_INTERVAL_MS);
    }
}

async function main(): Promise<void> {
    let options: CliOptions;
    let runIds: string[];
    try {
        options = parseArguments(process.argv.slice(2));
        runIds = options.pr
            ? await resolvePrRuns(options.pr, options.workflow)
            : [options.run ?? (await resolveRunId(options.branch))];
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
