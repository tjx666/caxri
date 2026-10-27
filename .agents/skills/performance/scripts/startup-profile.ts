/**
 * Launches a packaged Caxri repeatedly against one isolated profile and prints the median of each startup milestone
 * from the `app.startup_profile` and `server_core.ready` records. The first launch of a profile is reported apart from
 * the rest because it also pays one-time costs (cold OS file cache, profile creation, database migrations); every later
 * launch is a warm restart with a fresh Server Core. Pass `--variant` more than once to A/B two builds (or one build
 * under two environments) interleaved, so machine drift during the run hits both sides equally. `--seed
 * projects,sessions,archived,terminals` fills each profile with that many synthetic rows after its first launch (which
 * creates the schema), so the warm launches measure a used profile instead of an empty one.
 *
 * Run it under the desktop lease:
 *
 * Bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts desktop --label "startup profile" --\
 * Bun run .agents/skills/performance/scripts/startup-profile.ts\
 * --variant base=/tmp/Caxri-base.app/Contents/MacOS/Caxri\
 * --variant head=release.noindex/mac-arm64/Caxri.app/Contents/MacOS/Caxri --runs 7
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
    warmP95: Partial<Record<Metric, number>>;
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

/**
 * Nearest-rank percentile, so a small run count reports a value that was actually observed.
 */
export function percentile(values: readonly number[], rank: number): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.min(sorted.length, Math.ceil((rank / 100) * sorted.length)) - 1];
}

export function summarizeStartupRuns(runs: readonly StartupRun[]): StartupSummary {
    const [first = {}, ...warm] = runs;
    const warmMedian: Partial<Record<Metric, number>> = {};
    const warmP95: Partial<Record<Metric, number>> = {};
    for (const metric of METRICS) {
        const values = warm.map((run) => run[metric]).filter((entry) => typeof entry === 'number');
        const middle = median(values);
        if (middle !== undefined) warmMedian[metric] = middle;
        const tail = percentile(values, 95);
        if (tail !== undefined) warmP95[metric] = tail;
    }
    return { first, warmMedian, warmP95, warmRuns: warm.length };
}

export interface ProfileSeed {
    archived: number;
    projects: number;
    sessions: number;
    terminals: number;
}

export function parseProfileSeed(value: string | undefined): ProfileSeed | undefined {
    if (value === undefined) return undefined;
    const counts = value.split(',').map(Number);
    if (counts.length !== 4 || counts.some((count) => !Number.isSafeInteger(count) || count < 0))
        throw new Error(`--seed must be projects,sessions,archived,terminals: ${value}`);
    const [projects, sessions, archived, terminals] = counts;
    if (projects < 1 || archived > sessions || (sessions > 0 && terminals < sessions))
        throw new Error(
            `--seed needs a Project, archived <= sessions, terminals >= sessions: ${value}`,
        );
    return { archived, projects, sessions, terminals };
}

interface SeedDatabase {
    close(): void;
    prepare(sql: string): { run(...values: Array<number | string | null>): unknown };
    transaction(work: () => void): () => void;
}

/**
 * Adds synthetic Projects, Sessions, and Terminals to a profile whose first launch already created the schema. Every
 * Project root is an empty directory inside the profile, and every Terminal is a stopped shell, so no launch restores a
 * process or reads a real file. The selection stays on the first launch's own Session.
 */
async function seedProfile(userData: string, seed: ProfileSeed): Promise<void> {
    // The scripts project does not load Bun's type declarations, so the module is named through a variable (TypeScript
    // would otherwise fail to resolve it) and the slice of `bun:sqlite` used here is typed locally.
    const sqliteModule = 'bun:sqlite';
    const { Database } = (await import(sqliteModule)) as {
        Database: new (path: string) => SeedDatabase;
    };
    const database = new Database(join(userData, 'caxri.db'));
    try {
        const now = Date.now();
        const projectIds = Array.from(
            { length: seed.projects },
            (_, index) => `seed-project-${index}`,
        );
        await Promise.all(
            projectIds.map((id) => mkdir(join(userData, 'seed-roots', id), { recursive: true })),
        );
        database.transaction(() => {
            const project = database.prepare(
                'INSERT INTO projects (id, root_path, title, order_index, created_at, last_visited_at) VALUES (?, ?, ?, ?, ?, ?)',
            );
            for (const [index, id] of projectIds.entries())
                project.run(
                    id,
                    join(userData, 'seed-roots', id),
                    `Project ${index}`,
                    1_000 + index,
                    now,
                    now,
                );
            const session = database.prepare(
                'INSERT INTO sessions (id, project_id, created_at, last_visited_at, session_activity_at, sidebar_order, archived_at, title, title_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
            const state = database.prepare(
                "INSERT INTO session_views (session_id, desired_secondary_sidebar_view_container_id) VALUES (?, 'caxri.files')",
            );
            const terminal = database.prepare(
                "INSERT INTO terminals (id, session_id, kind, cwd, title, icon, order_index, last_process_state, created_at, updated_at) VALUES (?, ?, 'shell', ?, 'zsh', 'terminal', ?, 'stopped', ?, ?)",
            );
            for (let index = 0; index < seed.sessions; index += 1) {
                const projectId = projectIds[index % projectIds.length];
                const id = `seed-session-${index}`;
                const at = now - index * 60_000;
                session.run(
                    id,
                    projectId,
                    at,
                    at,
                    at,
                    1_000 + index,
                    index < seed.archived ? at : null,
                    `Session ${index}`,
                    'manual',
                );
                state.run(id);
            }
            for (let index = 0; index < seed.terminals && seed.sessions > 0; index += 1) {
                const sessionIndex = index % seed.sessions;
                terminal.run(
                    `seed-terminal-${index}`,
                    `seed-session-${sessionIndex}`,
                    join(userData, 'seed-roots', projectIds[sessionIndex % projectIds.length]),
                    Math.floor(index / seed.sessions),
                    now,
                    now,
                );
            }
        })();
    } finally {
        database.close();
    }
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
            seed: { type: 'string' },
            settle: { type: 'string', default: '3000' },
            variant: { type: 'string', multiple: true, default: [] },
        },
    });
    const runs = Number(values.runs);
    const settleMs = Number(values.settle);
    const seed = parseProfileSeed(values.seed);
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
                // eslint-disable-next-line no-await-in-loop -- the seed must land before this profile's next launch
                if (round === 0 && seed) await seedProfile(variant.userData, seed);
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
            'warm p95 (ms)',
            summaries.map((summary) => summary.label),
        ),
    );
    for (const metric of METRICS)
        console.log(
            formatRow(
                metric,
                summaries.map((summary) => summary.warmP95[metric]),
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
