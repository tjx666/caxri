import { createWriteStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { AppSettings, LastDatabaseRebuild } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, getMethodSpec, isLogProcess, logProcesses } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, redactLogValue, redactSecrets } from '@caxri/system';

import { botDiagnostics } from './bot';
import type { CaxriDatabase } from './db';
import { diagnosticSettings } from './diagnostic-settings';
import type { WatchHubSnapshot } from './watch';

/**
 * Matches every rotated generation the logger keeps (`.jsonl`, `.jsonl.1`, `.jsonl.2`, ...). Matching any numeric
 * suffix rather than hardcoding `StructuredLogger`'s current `MAX_LOG_GENERATIONS` bound keeps diagnostics snapshots
 * and exports complete if that retention window changes without both sites needing to move together.
 */
const DIAGNOSTIC_LOG_NAME = new RegExp(
    String.raw`^(?:${logProcesses.join('|')})\.jsonl(?:\.\d+)?$`,
    'u',
);

/**
 * Sorted diagnostic log file names for a profile directory listing. Exposed for unit coverage so that
 * `DIAGNOSTIC_LOG_NAME` stays aligned with the logger's rotation contract without spinning up the full service.
 */
export function pickDiagnosticLogNames(names: string[]): string[] {
    return names
        .filter((name) => DIAGNOSTIC_LOG_NAME.test(name))
        .toSorted((left, right) => left.localeCompare(right));
}

export function normalizeHome(path: string): string {
    const home = homedir();
    return path === home
        ? '$HOME'
        : path.startsWith(`${home}/`)
          ? `$HOME/${path.slice(home.length + 1)}`
          : path;
}

/**
 * The latest clean-install cutoff rebuild for `host.status` and the diagnostics snapshot, with the backup path
 * home-normalized, or `undefined` when none happened (or the cell is unreadable: a status read must never fail on it).
 */
export function lastDatabaseRebuildReport(database: {
    getAppState: (key: 'lastDatabaseRebuild') => LastDatabaseRebuild | undefined;
}): LastDatabaseRebuild | undefined {
    try {
        const rebuild = database.getAppState('lastDatabaseRebuild');
        return rebuild && { ...rebuild, backupPath: normalizeHome(rebuild.backupPath) };
    } catch {
        return undefined;
    }
}

function json(value: unknown): string {
    return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}

/**
 * Exact `diagnostics/settings.json` content: the explicit per-key projection removes Agent prompt text and argv
 * credentials, then the generic pass redacts secret-named keys, token-shaped values, and home paths.
 */
export function diagnosticSettingsFile(settings: AppSettings): string {
    return json(diagnosticSettings(settings));
}

/**
 * Where an `ipc.request` duration was measured: `relay` is the control boundary (it carries `principal` and includes
 * the admission queue, so it is the latency a client saw), `handler` is the domain handler alone. One relayed request
 * writes both, so they are never merged into one row.
 */
type PerformanceBoundary = 'handler' | 'relay';

interface PerformanceKey {
    boundary?: PerformanceBoundary;
    event: string;
    key?: string;
}

interface PerformanceAggregate extends PerformanceKey {
    firstAt: string;
    lastAt: string;
    maximumMs: number;
    minimumMs: number;
    samples: number[];
    totalMs: number;
}

export interface PerformanceSummary {
    event: string;
    key?: string;
    boundary?: PerformanceBoundary;
    count: number;
    averageMs: number;
    minimumMs: number;
    p50Ms: number;
    p95Ms: number;
    maximumMs: number;
    firstAt: string;
    lastAt: string;
}

/**
 * Bound on summary rows, matching the `diagnostics.snapshot` schema.
 */
const MAX_PERFORMANCE_ROWS = 256;
/**
 * Keys one grouped event (per boundary) keeps by total time; the rest fold into its `other` row.
 */
const MAX_KEYS_PER_GROUPED_EVENT = 32;
const OTHER_PERFORMANCE_KEY = 'other';
const GIT_OPERATION_KEY = /^[a-z][a-z-]*(?:\.[a-z-]+)?$/u;

/**
 * The closed set of events summarized per key, and how each reads its key. Only registered method names and Git
 * operation names (never a path or ref; see `classifyGitOperation`) become keys; any other value folds into `other`, so
 * a malformed or dynamic field can never add a row or reach the summary.
 */
function performanceKey(
    event: string,
    fields: Record<string, unknown>,
): PerformanceKey | undefined {
    if (event === 'ipc.request') {
        // The durable finalizer's record times work its handler record already covers; counting it would double it.
        if (fields.transaction === 'durable-finalizer') return undefined;
        const { method } = fields;
        return {
            event,
            key:
                typeof method === 'string' && getMethodSpec(method)
                    ? method
                    : OTHER_PERFORMANCE_KEY,
            boundary: fields.principal === undefined ? 'handler' : 'relay',
        };
    }
    if (event === 'git.command') {
        const { operation } = fields;
        return {
            event,
            key:
                typeof operation === 'string' && GIT_OPERATION_KEY.test(operation)
                    ? operation
                    : OTHER_PERFORMANCE_KEY,
        };
    }
    return { event };
}

interface ErrorIdentifierRecord {
    id: string;
    timestamp: string;
}

/**
 * Selects identifiers only; error messages, stacks, and structured fields never leave the logs.
 */
export function summarizeRecentErrorIds(logs: string, limit = 5): string[] {
    const records: ErrorIdentifierRecord[] = [];
    for (const line of logs.split('\n')) {
        if (!line) continue;
        try {
            const record = JSON.parse(line) as {
                correlationId?: unknown;
                event?: unknown;
                level?: unknown;
                process?: unknown;
                timestamp?: unknown;
            };
            if (
                record.level !== 'error' ||
                !isLogProcess(record.process) ||
                typeof record.event !== 'string' ||
                typeof record.timestamp !== 'string'
            )
                continue;
            const id =
                typeof record.correlationId === 'string' && record.correlationId
                    ? `${record.process}:${record.correlationId}`
                    : `${record.process}:${record.event}:${record.timestamp}`;
            records.push({ id, timestamp: record.timestamp });
        } catch {
            // Ignore truncated lines left by an interrupted log write.
        }
    }
    const boundedLimit = Math.min(5, Math.max(0, Math.trunc(limit)));
    if (boundedLimit === 0) return [];
    const recent = records.toSorted((left, right) => left.timestamp.localeCompare(right.timestamp));
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const record of recent.toReversed()) {
        if (!seen.has(record.id)) {
            seen.add(record.id);
            unique.push(record.id);
        }
        if (unique.length === boundedLimit) break;
    }
    return unique.toReversed();
}

function addPerformanceSample(
    aggregates: Map<string, PerformanceAggregate>,
    group: PerformanceKey,
    durationMs: number,
    timestamp: string,
): void {
    const id = `${group.event}\u{0}${group.key ?? ''}\u{0}${group.boundary ?? ''}`;
    const aggregate = aggregates.get(id) ?? {
        ...group,
        firstAt: timestamp,
        lastAt: timestamp,
        maximumMs: durationMs,
        minimumMs: durationMs,
        samples: [],
        totalMs: 0,
    };
    aggregate.samples.push(durationMs);
    aggregate.totalMs += durationMs;
    aggregate.maximumMs = Math.max(aggregate.maximumMs, durationMs);
    aggregate.minimumMs = Math.min(aggregate.minimumMs, durationMs);
    if (timestamp < aggregate.firstAt) aggregate.firstAt = timestamp;
    if (timestamp > aggregate.lastAt) aggregate.lastAt = timestamp;
    aggregates.set(id, aggregate);
}

function accumulatePerformanceLogLines(
    log: string,
    aggregates: Map<string, PerformanceAggregate>,
): void {
    for (const line of log.split('\n')) {
        if (!line) continue;
        try {
            const entry = JSON.parse(line) as {
                durationMs?: unknown;
                event?: unknown;
                fields?: unknown;
                timestamp?: unknown;
            };
            if (typeof entry.event !== 'string' || typeof entry.durationMs !== 'number') continue;
            if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0) continue;
            // Every logger record is stamped; a line without a time cannot place itself in the summary's window.
            if (typeof entry.timestamp !== 'string') continue;
            const fields =
                entry.fields !== null && typeof entry.fields === 'object'
                    ? (entry.fields as Record<string, unknown>)
                    : {};
            const group = performanceKey(entry.event, fields);
            if (group) addPerformanceSample(aggregates, group, entry.durationMs, entry.timestamp);
        } catch {
            // Ignore truncated lines left by an interrupted log write.
        }
    }
}

function mergePerformanceAggregates(
    group: PerformanceKey,
    parts: readonly PerformanceAggregate[],
): PerformanceAggregate {
    /**
     * ISO timestamps order lexically; `Math.min` would coerce them to NaN.
     */
    const byText = (left: string, right: string) => left.localeCompare(right);
    const [firstAt] = parts.map((part) => part.firstAt).toSorted(byText);
    const [lastAt] = parts
        .map((part) => part.lastAt)
        .toSorted((left, right) => byText(right, left));
    return {
        ...group,
        firstAt,
        lastAt,
        maximumMs: Math.max(...parts.map((part) => part.maximumMs)),
        minimumMs: Math.min(...parts.map((part) => part.minimumMs)),
        samples: parts.flatMap((part) => part.samples),
        totalMs: parts.reduce((total, part) => total + part.totalMs, 0),
    };
}

/**
 * Keeps each grouped event's {@link MAX_KEYS_PER_GROUPED_EVENT} costliest keys per boundary and folds the rest, and any
 * existing `other`, into one `other` row, so a long tail of methods cannot push ungrouped events out of the bound.
 */
function foldPerformanceKeyTails(
    aggregates: readonly PerformanceAggregate[],
): PerformanceAggregate[] {
    const groups = new Map<string, PerformanceAggregate[]>();
    const rows: PerformanceAggregate[] = [];
    for (const aggregate of aggregates) {
        if (aggregate.key === undefined) {
            rows.push(aggregate);
            continue;
        }
        const id = `${aggregate.event}\u{0}${aggregate.boundary ?? ''}`;
        groups.set(id, [...(groups.get(id) ?? []), aggregate]);
    }
    for (const members of groups.values()) {
        const ranked = members
            .filter((member) => member.key !== OTHER_PERFORMANCE_KEY)
            .toSorted((left, right) => right.totalMs - left.totalMs);
        rows.push(...ranked.slice(0, MAX_KEYS_PER_GROUPED_EVENT));
        const folded = [
            ...ranked.slice(MAX_KEYS_PER_GROUPED_EVENT),
            ...members.filter((member) => member.key === OTHER_PERFORMANCE_KEY),
        ];
        if (folded.length > 0) {
            const [{ event, boundary }] = members;
            rows.push(
                mergePerformanceAggregates(
                    { event, key: OTHER_PERFORMANCE_KEY, ...(boundary && { boundary }) },
                    folded,
                ),
            );
        }
    }
    return rows;
}

/**
 * Nearest-rank percentile over ascending samples.
 */
function percentile(sorted: readonly number[], fraction: number): number {
    return sorted[
        Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
    ];
}

function performanceRow(aggregate: PerformanceAggregate): PerformanceSummary {
    const sorted = aggregate.samples.toSorted((left, right) => left - right);
    return {
        event: aggregate.event,
        ...(aggregate.key !== undefined && { key: aggregate.key }),
        ...(aggregate.boundary && { boundary: aggregate.boundary }),
        count: sorted.length,
        averageMs: Math.round((aggregate.totalMs / sorted.length) * 100) / 100,
        minimumMs: aggregate.minimumMs,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maximumMs: aggregate.maximumMs,
        firstAt: aggregate.firstAt,
        lastAt: aggregate.lastAt,
    };
}

/**
 * Builds a content-free timing summary from already structured operation logs, so an Agent can rank where Server time
 * goes without reading raw logs. `ipc.request` is split by method and boundary and `git.command` by operation; every
 * other event is one row. Each row carries nearest-rank p50 and p95 and the window it covers. Rows are ordered by total
 * time, each grouped event's `other` row last, and bounded to {@link MAX_PERFORMANCE_ROWS}: ungrouped events are kept
 * first, then the costliest keyed rows.
 */
export function summarizePerformanceLogs(logs: string[]): PerformanceSummary[] {
    const aggregates = new Map<string, PerformanceAggregate>();
    for (const log of logs) accumulatePerformanceLogLines(log, aggregates);
    const rows = foldPerformanceKeyTails(aggregates.values().toArray());
    const byTotal = (left: PerformanceAggregate, right: PerformanceAggregate) =>
        right.totalMs - left.totalMs;
    const ungrouped = rows.filter((row) => row.key === undefined).toSorted(byTotal);
    const keyed = rows.filter((row) => row.key !== undefined).toSorted(byTotal);
    const kept = [
        ...ungrouped,
        ...keyed.slice(0, Math.max(0, MAX_PERFORMANCE_ROWS - ungrouped.length)),
    ].slice(0, MAX_PERFORMANCE_ROWS);
    const isOther = (row: PerformanceAggregate) => row.key === OTHER_PERFORMANCE_KEY;
    return [
        ...kept.filter((row) => !isOther(row)).toSorted(byTotal),
        ...kept.filter(isOther).toSorted(byTotal),
    ].map(performanceRow);
}

export class DiagnosticsService {
    constructor(
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly getSettings: () => AppSettings,
        private readonly activePtyCount: () => number,
        private readonly startedAt: number,
        /**
         * Content-free watcher/poller census from the Server watch hub (labels and counters only, never paths).
         */
        private readonly watchSnapshot?: () => WatchHubSnapshot,
    ) {}

    private async readLogs(): Promise<string[]> {
        const logDirectory = dirname(this.logger.path);
        let names: string[];
        try {
            names = await readdir(logDirectory);
        } catch {
            names = [];
        }
        const logNames = pickDiagnosticLogNames(names);
        return Promise.all(
            logNames.map(async (name) => {
                try {
                    return await readFile(join(logDirectory, name), 'utf8');
                } catch {
                    return '';
                }
            }),
        );
    }

    /**
     * Returns only bounded counters and identifiers; paths, messages, and log fields stay local.
     */
    async snapshot() {
        const logs = await this.readLogs();
        const lastDatabaseRebuild = lastDatabaseRebuildReport(this.database);
        return {
            appVersion: process.env.CAXRI_APP_VERSION ?? 'unknown',
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            runtimeStatus: 'ready' as const,
            startedAt: this.startedAt,
            activePtyCount: this.activePtyCount(),
            projectCount: this.database.listProjects().length,
            sessionCount: this.database.listSessions().length,
            terminalCount: this.database.listTerminals().length,
            recentErrorIds: summarizeRecentErrorIds(logs.join('\n')),
            performance: summarizePerformanceLogs(logs),
            ...(this.watchSnapshot && { watchers: this.watchSnapshot() }),
            caxriBot: botDiagnostics(this.database, logs),
            ...(lastDatabaseRebuild && { lastDatabaseRebuild }),
        };
    }

    async reportContext(): Promise<{
        appVersion: string;
        architecture: string;
        commit: string;
        platform: string;
        recentErrorIds: string[];
    }> {
        const logs = await this.readLogs();
        return {
            appVersion: process.env.CAXRI_APP_VERSION ?? 'unknown',
            architecture: process.arch,
            commit: process.env.CAXRI_GIT_COMMIT ?? 'unknown',
            platform: process.platform,
            recentErrorIds: summarizeRecentErrorIds(logs.join('\n')),
        };
    }

    async export(destination: string): Promise<{ path: string }> {
        const projects = this.database.listProjects().map((project) => ({
            id: project.id,
            rootPath: normalizeHome(project.rootPath),
            createdAt: project.createdAt,
            lastVisitedAt: project.lastVisitedAt,
        }));
        const sessions = this.database.listSessions().map((session) => ({
            id: session.id,
            projectId: session.projectId,
            createdAt: session.createdAt,
            lastVisitedAt: session.lastVisitedAt,
            agentActivityState: session.agentActivityState,
            attentionGeneration: session.attentionGeneration,
            acknowledgedAttentionGeneration: session.acknowledgedAttentionGeneration,
            lastAttentionKind: session.lastAttentionKind,
            hasUnread: session.hasUnread,
        }));
        const terminals = this.database.listTerminals().map((terminal) => ({
            id: terminal.id,
            sessionId: terminal.sessionId,
            kind: terminal.kind,
            provider: terminal.provider,
            cwd: normalizeHome(terminal.cwd),
            lastProcessState: terminal.lastProcessState,
            createdAt: terminal.createdAt,
            updatedAt: terminal.updatedAt,
        }));
        const logDirectory = dirname(this.logger.path);
        const logNames = pickDiagnosticLogNames(await readdir(logDirectory));
        const redactedLogs = await Promise.all(
            logNames.map(async (name) => ({
                name,
                content: redactLogValue(await readFile(join(logDirectory, name), 'utf8')),
            })),
        );
        const performance = summarizePerformanceLogs(redactedLogs.map((log) => log.content));
        const settings = diagnosticSettingsFile(this.getSettings());

        /**
         * Archiver and its stream stack (about 300 KB of bundled source) load only when a diagnostics export runs, so
         * they stay out of the resident Server Core startup chunk.
         */
        const { ZipArchive } = await import('archiver');
        await new Promise<void>((resolve, reject) => {
            const output = createWriteStream(destination, { mode: 0o600 });
            const archive = new ZipArchive({ zlib: { level: 9 } });
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
            archive.pipe(output);
            archive.append(
                json({
                    name: 'Caxri',
                    appVersion: process.env.CAXRI_APP_VERSION ?? 'unknown',
                    commit: process.env.CAXRI_GIT_COMMIT ?? 'unknown',
                    platform: process.platform,
                    architecture: process.arch,
                    electron: process.versions.electron,
                    node: process.versions.node,
                    generatedAt: new Date().toISOString(),
                    telemetry: false,
                }),
                { name: 'diagnostics/app.json' },
            );
            archive.append(
                json({ startedAt: this.startedAt, activePtyCount: this.activePtyCount() }),
                {
                    name: 'diagnostics/runtime.json',
                },
            );
            archive.append(json(projects), { name: 'diagnostics/projects.json' });
            archive.append(json(sessions), { name: 'diagnostics/sessions.json' });
            archive.append(json(terminals), { name: 'diagnostics/terminals.json' });
            archive.append(settings, { name: 'diagnostics/settings.json' });
            archive.append(json(performance), { name: 'diagnostics/performance.json' });
            for (const log of redactedLogs)
                archive.append(log.content, { name: `diagnostics/logs/${log.name}` });
            // The Promise executor is a synchronous callback, so this cannot become `await`; the
            // `archive.on('error', reject)` listener above already rejects the outer Promise for
            // the same failure, so this `.catch()` only silences the now-redundant rejection.
            // eslint-disable-next-line unicorn/prefer-await -- sync Promise-executor callback, see comment above
            archive.finalize().catch(() => {});
        });
        this.logger.write('info', logEventCatalog.diagnostics.exported);
        return { path: destination };
    }
}
