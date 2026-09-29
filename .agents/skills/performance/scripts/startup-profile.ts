/**
 * Launches a packaged Caxri repeatedly against one isolated profile and prints the median of each startup milestone
 * from the `app.startup_profile` and `server_core.ready` records. The first launch of a profile is reported apart from
 * the rest because it also pays one-time costs (cold OS file cache, profile creation, database migrations); every later
 * launch is a warm restart with a fresh Server Core. Pass `--variant` more than once to A/B two builds (or one build
 * under two environments) interleaved, so machine drift during the run hits both sides equally.
 *
 * Run it under the desktop lease:
 *
 * Bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts desktop --label "startup profile" --\
 * Bun run .agents/skills/performance/scripts/startup-profile.ts\
 * --variant base=/tmp/Caxri-base.app/Contents/MacOS/Caxri\
 * --variant head=release.noindex/mac-arm64/Caxri.app/Contents/MacOS/Caxri --runs 7
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

/**
 * Desktop milestones in launch order, as written by `apps/desktop/src/main/startup-profile.ts`.
 */
const DESKTOP_FIELDS = [
    'mainModuleMs',
    'appReadyMs',
    'serverAttachedMs',
    'windowCreatedMs',
    'readyToShowMs',
    'windowShownMs',
    'rendererReadyMs',
    'loaderRemovedMs',
    'firstFrameMs',
] as const;

/**
 * `server.readyMs` is the `durationMs` of `server_core.ready`: Server Core's own startup, Extension Host included,
 * measured from its entry module, so it excludes Node boot.
 */
const METRICS = [...DESKTOP_FIELDS, 'server.readyMs'] as const;

type Metric = (typeof METRICS)[number];

export type StartupRun = Partial<Record<Metric, number>>;

export interface StartupSummary {
    first: StartupRun;
    warmMedian: Partial<Record<Metric, number>>;
    warmRuns: number;
}

interface LogRecord {
    durationMs?: number;
    event?: string;
    fields?: Record<string, unknown>;
}

export function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeStartupRuns(runs: readonly StartupRun[]): StartupSummary {
    const [first = {}, ...warm] = runs;
    const warmMedian: Partial<Record<Metric, number>> = {};
    for (const metric of METRICS) {
        const value = median(
            warm.map((run) => run[metric]).filter((entry) => typeof entry === 'number'),
        );
        if (value !== undefined) warmMedian[metric] = value;
    }
    return { first, warmMedian, warmRuns: warm.length };
}

/**
 * Reads the newest record of `event` from a JSONL log, or `undefined` while it has not been written yet.
 */
export function lastRecord(contents: string, event: string): LogRecord | undefined {
    let found: LogRecord | undefined;
    for (const line of contents.split('\n')) {
        if (!line.includes(event)) continue;
        try {
            const record = JSON.parse(line) as LogRecord;
            if (record.event === event) found = record;
        } catch {
            // A line still being written; the next poll reads it whole.
        }
    }
    return found;
}

async function readLog(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return '';
    }
}

async function waitForRecord(
    path: string,
    event: string,
    after: number,
    timeoutMs: number,
): Promise<LogRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- poll loop: each iteration reads then sleeps
        const contents = await readLog(path);
        const lines = contents.split('\n').length;
        if (lines > after) {
            const record = lastRecord(contents.split('\n').slice(after).join('\n'), event);
            if (record) return record;
        }
        // eslint-disable-next-line no-await-in-loop -- bounded poll interval
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${event} in ${path}`);
}

async function lineCount(path: string): Promise<number> {
    return (await readLog(path)).split('\n').length - 1;
}

function numberField(fields: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = fields?.[key];
    return typeof value === 'number' ? value : undefined;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopPid(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
    if (!pid || !isAlive(pid)) return;
    process.kill(pid, signal);
    // eslint-disable-next-line no-await-in-loop -- bounded process-exit observation interval
    for (let attempt = 0; attempt < 100 && isAlive(pid); attempt += 1) await sleep(100);
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
}

interface Variant {
    environment: Record<string, string>;
    executable: string;
    label: string;
    userData: string;
}

/**
 * One launch: wait for the first-frame record, let post-startup background work settle so it cannot spill into the next
 * launch, then stop the launched Desktop and the Server Core it spawned. Server Core is detached by design, so it is
 * stopped by the pid it logged, never by name.
 */
async function launchOnce(variant: Variant, settleMs: number): Promise<StartupRun> {
    const logs = join(variant.userData, 'logs');
    const desktopLog = join(logs, 'desktop.jsonl');
    const serverLog = join(logs, 'server-core.jsonl');
    const desktopOffset = await lineCount(desktopLog);
    const serverOffset = await lineCount(serverLog);
    const child = spawn(variant.executable, [], {
        env: { ...process.env, ...variant.environment, CAXRI_USER_DATA_DIR: variant.userData },
        stdio: 'ignore',
    });
    let serverPid: number | undefined;
    try {
        const profile = await waitForRecord(
            desktopLog,
            'app.startup_profile',
            desktopOffset,
            60_000,
        );
        const ready = await waitForRecord(serverLog, 'server_core.ready', serverOffset, 10_000);
        serverPid = numberField(ready.fields, 'pid');
        const run: StartupRun = {};
        for (const field of DESKTOP_FIELDS) {
            const value = numberField(profile.fields, field);
            if (value !== undefined) run[field] = value;
        }
        if (typeof ready.durationMs === 'number') run['server.readyMs'] = ready.durationMs;
        await sleep(settleMs);
        return run;
    } finally {
        await stopPid(child.pid, 'SIGKILL');
        await stopPid(serverPid, 'SIGTERM');
    }
}

function parseVariants(values: string[], environments: string[]): Array<Omit<Variant, 'userData'>> {
    return values.map((value) => {
        const separator = value.indexOf('=');
        if (separator <= 0)
            throw new Error(`--variant must be label=/path/to/executable: ${value}`);
        const label = value.slice(0, separator);
        const environment: Record<string, string> = {};
        for (const entry of environments) {
            if (!entry.startsWith(`${label}:`)) continue;
            const assignment = entry.slice(label.length + 1);
            const equals = assignment.indexOf('=');
            if (equals <= 0) throw new Error(`--env must be label:KEY=VALUE: ${entry}`);
            environment[assignment.slice(0, equals)] = assignment.slice(equals + 1);
        }
        return { environment, executable: resolve(value.slice(separator + 1)), label };
    });
}

function formatRow(label: string, values: Array<number | string | undefined>): string {
    return [label.padEnd(24), ...values.map((value) => String(value ?? '-').padStart(10))].join('');
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            env: { type: 'string', multiple: true, default: [] },
            runs: { type: 'string', default: '7' },
            settle: { type: 'string', default: '3000' },
            variant: { type: 'string', multiple: true, default: [] },
        },
    });
    const runs = Number(values.runs);
    const settleMs = Number(values.settle);
    const variants: Variant[] = await Promise.all(
        parseVariants(values.variant, values.env).map(async (variant) => ({
            ...variant,
            userData: await mkdtemp(join(tmpdir(), `caxri-startup-${variant.label}-`)),
        })),
    );
    if (variants.length === 0)
        throw new Error('Pass at least one --variant label=/path/to/executable');
    const results = new Map<string, StartupRun[]>(variants.map((variant) => [variant.label, []]));
    try {
        // Launch zero is the profile's first launch; the rest are warm. Interleave variants within each round.
        for (let round = 0; round <= runs; round += 1)
            for (const variant of variants) {
                // eslint-disable-next-line no-await-in-loop -- launches must not overlap, or they measure each other
                const run = await launchOnce(variant, settleMs);
                results.get(variant.label)!.push(run);
                process.stderr.write(
                    `${variant.label} #${round}: firstFrame=${run.firstFrameMs}ms\n`,
                );
            }
    } finally {
        await Promise.all(
            variants.map((variant) => rm(variant.userData, { force: true, recursive: true })),
        );
    }
    const summaries = variants.map((variant) => ({
        label: variant.label,
        ...summarizeStartupRuns(results.get(variant.label)!),
    }));
    console.log(
        formatRow(
            'warm median (ms)',
            summaries.map((summary) => summary.label),
        ),
    );
    for (const metric of METRICS)
        console.log(
            formatRow(
                metric,
                summaries.map((summary) => summary.warmMedian[metric]),
            ),
        );
    console.log(
        formatRow(
            'first launch firstFrame',
            summaries.map((summary) => summary.first.firstFrameMs),
        ),
    );
    console.log(`CAXRI_STARTUP_PROFILE ${JSON.stringify(summaries)}`);
}

if (import.meta.main) await main();
