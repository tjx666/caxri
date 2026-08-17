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
 * - Immediate failure notification: the first time any job concludes failed/timed_out/cancelled a macOS notification
 *   fires, without waiting for the whole run to complete. Notified jobs are recorded in the shared state so reruns and
 *   follower sessions do not re-notify.
 * - Offline resilience: polling errors are treated as transient and retried forever with capped exponential backoff; the
 *   watcher only exits when the run reaches a terminal status.
 *
 * Usage: `bun run scripts/watch-ci.ts [--run <id>] [--branch <name>] [--quiet]` Defaults to the newest run on the
 * current git branch. Exits 0 on success, 1 otherwise.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 20_000;
/**
 * A heartbeat older than three poll intervals means the polling session died (or its laptop slept); the next follower
 * promotes itself. Two concurrent promotions only cost one duplicate request before the state file converges, so the
 * race is left unlocked on purpose.
 */
const HEARTBEAT_STALE_MS = POLL_INTERVAL_MS * 3;
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
    conclusion: string;
    heartbeatAt: string;
    jobs: WatchedJob[];
    notifiedFailedJobs: string[];
    pollerPid: number;
    runId: string;
    status: string;
    url?: string;
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

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/watch-ci.test.ts
export function nextBackoffMs(currentMs: number): number {
    return Math.min(Math.max(currentMs, INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
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
export function formatRunSummary(state: Pick<WatchState, 'conclusion' | 'jobs' | 'runId'>): string {
    const lines = [`run ${state.runId}: ${state.conclusion || 'in progress'}`];
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
    await mkdir(STATE_DIRECTORY, { recursive: true });
    const finalPath = statePath(state.runId);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, 'utf8');
    await rename(temporaryPath, finalPath);
}

/**
 * Repository icon shown on alerter notifications; resolved from the script location so worktrees work too.
 */
const APP_ICON_PATH = fileURLToPath(new URL('../build/icon.png', import.meta.url));

/**
 * How long an alerter notification stays up (and the poller blocks) waiting for a click before auto-closing. Failure
 * notifications are rare, so pausing the 20s poll cadence for up to this long is an acceptable trade for
 * click-to-open.
 */
const NOTIFICATION_TIMEOUT_SECONDS = 10;

/**
 * Best-effort macOS notification. Prefers `alerter` (brew) over `osascript` because AppleScript notifications are
 * permanently branded with the Script Editor icon and cannot react to clicks; alerter shows the repository icon and
 * clicking the notification opens the run page. Falls back to `osascript` only when alerter is not installed.
 */
async function notify(title: string, message: string, url?: string): Promise<void> {
    console.log(`${title}: ${message}`);
    if (process.platform !== 'darwin') return;
    try {
        const { stdout } = await execFileAsync('alerter', [
            '--title',
            title,
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

interface GhRunView {
    conclusion?: string;
    jobs?: Array<{ conclusion?: string; name?: string; status?: string }>;
    status?: string;
    url?: string;
}

async function fetchRun(runId: string): Promise<GhRunView> {
    try {
        const { stdout } = await execFileAsync(
            'gh',
            ['run', 'view', runId, '--json', 'status,conclusion,jobs,url'],
            { timeout: 60_000 },
        );
        return JSON.parse(stdout) as GhRunView;
    } catch {
        // GitHub's run-jobs list endpoint (`/actions/runs/<id>/jobs`) intermittently 404s for hours while the run
        // itself stays queryable, which used to trap the watcher in an endless retry loop that never reported the
        // run's conclusion. Degrade to status-only polling: per-job early failure notifications pause, but terminal
        // success/failure detection — the watcher's core contract — keeps working.
        const { stdout } = await execFileAsync(
            'gh',
            ['run', 'view', runId, '--json', 'status,conclusion,url'],
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
    quiet: boolean;
    run?: string;
}

/**
 * Applies one CLI argument and returns how many argv slots it consumed.
 */
function applyArgument(options: CliOptions, argument: string, value: string | undefined): number {
    if (argument === '--quiet') {
        options.quiet = true;
        return 1;
    }
    if (argument === '--run') {
        options.run = value;
        return 2;
    }
    if (argument === '--branch') {
        options.branch = value;
        return 2;
    }
    throw new Error(`unknown argument: ${argument}`);
}

function parseArguments(argv: string[]): CliOptions {
    const options: CliOptions = { quiet: false };
    let index = 0;
    while (index < argv.length) {
        index += applyArgument(options, argv[index], argv[index + 1]);
    }
    return options;
}

async function pollOnce(runId: string, previous: WatchState | undefined): Promise<WatchState> {
    const view = await fetchRun(runId);
    // A missing jobs array means fetchRun fell back to status-only polling; keep the last known job list instead of
    // erasing it so the printed summary stays informative.
    const jobs: WatchedJob[] = view.jobs
        ? view.jobs.map((job) => ({
              conclusion: job.conclusion ?? '',
              name: job.name ?? 'unknown job',
              status: job.status ?? '',
          }))
        : (previous?.jobs ?? []);
    const state: WatchState = {
        conclusion: view.conclusion ?? '',
        heartbeatAt: new Date().toISOString(),
        jobs,
        notifiedFailedJobs: previous?.notifiedFailedJobs ?? [],
        pollerPid: process.pid,
        runId,
        status: view.status ?? '',
        url: view.url,
    };
    const failedJobs = newlyFailedJobs(state.notifiedFailedJobs, jobs);
    if (failedJobs.length > 0) {
        state.notifiedFailedJobs = [...state.notifiedFailedJobs, ...failedJobs];
        await notify(
            'Caxri CI failed',
            `${failedJobs.join(', ')} — ${state.url ?? runId}`,
            state.url,
        );
    }
    await writeState(state);
    return state;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const runId = options.run ?? (await resolveRunId(options.branch));
    console.log(`watching run ${runId} (state: ${statePath(runId)})`);

    let backoffMs = INITIAL_BACKOFF_MS;
    let lastPrinted = '';
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- watch loop: each iteration observes then sleeps
        let state = await readState(runId);
        // Poll unless another live session already holds the poller role for this run.
        const isFollower =
            state !== undefined &&
            state.pollerPid !== process.pid &&
            !isHeartbeatStale(state.heartbeatAt, Date.now());
        if (!isFollower) {
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

        if (state) {
            const summary = formatRunSummary(state);
            if (summary !== lastPrinted && !options.quiet) {
                console.log(summary);
                lastPrinted = summary;
            }
            if (state.status === 'completed') {
                const isOk = state.conclusion === 'success';
                // eslint-disable-next-line no-await-in-loop -- terminal notification; the loop exits right after
                await (isOk
                    ? notify('Caxri CI passed', `run ${runId}`, state.url)
                    : notify('Caxri CI failed', `run ${runId}: ${state.conclusion}`, state.url));
                process.exit(isOk ? 0 : 1);
            }
        }
        // eslint-disable-next-line no-await-in-loop -- watch loop: fixed poll cadence
        await sleep(POLL_INTERVAL_MS);
    }
}

if (import.meta.main) {
    await main();
}
