import { createWriteStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ZipArchive } from 'archiver';

import type { StructuredLogger } from '../shared/node/logger';
import { redactLogValue, redactSecrets } from '../shared/node/redaction';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';
import type { AppSettings } from '../shared/types';
import type { CaxriDatabase } from './db';

const DIAGNOSTIC_LOG_NAME = /^(host|main|runtime)\.jsonl(?:\.1)?$/u;

export function normalizeHome(path: string): string {
    const home = homedir();
    return path === home
        ? '$HOME'
        : path.startsWith(`${home}/`)
          ? `$HOME/${path.slice(home.length + 1)}`
          : path;
}

function json(value: unknown): string {
    return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}

interface PerformanceAggregate {
    count: number;
    maximumMs: number;
    minimumMs: number;
    totalMs: number;
}

export interface PerformanceSummary {
    event: string;
    count: number;
    averageMs: number;
    minimumMs: number;
    maximumMs: number;
}

interface ErrorIdentifierRecord {
    id: string;
    timestamp: string;
}

/** Selects identifiers only; error messages, stacks, and structured fields never leave the logs. */
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
                (record.process !== 'host' &&
                    record.process !== 'main' &&
                    record.process !== 'runtime') ||
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
    const recent = records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const record of recent.toReversed()) {
        if (!seen.has(record.id)) {
            seen.add(record.id);
            unique.push(record.id);
        }
        if (unique.length === boundedLimit) break;
    }
    return unique.reverse();
}

/** Builds a content-free timing summary from already structured operation logs. */
export function summarizePerformanceLogs(logs: string[]): PerformanceSummary[] {
    const aggregates = new Map<string, PerformanceAggregate>();
    for (const log of logs) {
        for (const line of log.split('\n')) {
            if (!line) continue;
            try {
                const entry = JSON.parse(line) as { durationMs?: unknown; event?: unknown };
                if (typeof entry.event !== 'string' || typeof entry.durationMs !== 'number')
                    continue;
                if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0) continue;
                const aggregate = aggregates.get(entry.event) ?? {
                    count: 0,
                    maximumMs: entry.durationMs,
                    minimumMs: entry.durationMs,
                    totalMs: 0,
                };
                aggregate.count += 1;
                aggregate.maximumMs = Math.max(aggregate.maximumMs, entry.durationMs);
                aggregate.minimumMs = Math.min(aggregate.minimumMs, entry.durationMs);
                aggregate.totalMs += entry.durationMs;
                aggregates.set(entry.event, aggregate);
            } catch {
                // Ignore truncated lines left by an interrupted log write.
            }
        }
    }
    return [...aggregates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([event, aggregate]) => ({
            event,
            count: aggregate.count,
            averageMs: Math.round((aggregate.totalMs / aggregate.count) * 100) / 100,
            minimumMs: aggregate.minimumMs,
            maximumMs: aggregate.maximumMs,
        }));
}

export class DiagnosticsService {
    constructor(
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly getSettings: () => AppSettings,
        private readonly activePtyCount: () => number,
        private readonly startedAt: number,
    ) {}

    private async readLogs(): Promise<string[]> {
        const logDirectory = dirname(this.logger.path);
        const logNames = (await readdir(logDirectory).catch(() => []))
            .filter((name) => DIAGNOSTIC_LOG_NAME.test(name))
            .sort();
        return Promise.all(
            logNames.map((name) => readFile(join(logDirectory, name), 'utf8').catch(() => '')),
        );
    }

    /** Returns only bounded counters and identifiers; paths, messages, and log fields stay local. */
    async snapshot() {
        const logs = await this.readLogs();
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
            performance: summarizePerformanceLogs(logs).slice(0, 256),
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
            lastOpenedAt: project.lastOpenedAt,
        }));
        const sessions = this.database.listSessions().map((session) => ({
            id: session.id,
            projectId: session.projectId,
            createdAt: session.createdAt,
            lastOpenedAt: session.lastOpenedAt,
            lastActivityState: session.lastActivityState,
            attentionEpoch: session.attentionEpoch,
            readAttentionEpoch: session.readAttentionEpoch,
            lastAttentionKind: session.lastAttentionKind,
            hasUnread: session.hasUnread,
            layoutVersion: session.layoutVersion,
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
        const logNames = (await readdir(logDirectory))
            .filter((name) => DIAGNOSTIC_LOG_NAME.test(name))
            .sort();
        const redactedLogs = await Promise.all(
            logNames.map(async (name) => ({
                name,
                content: redactLogValue(await readFile(join(logDirectory, name), 'utf8')),
            })),
        );
        const performance = summarizePerformanceLogs(redactedLogs.map((log) => log.content));

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
            archive.append(json(this.getSettings()), { name: 'diagnostics/settings.json' });
            archive.append(json(performance), { name: 'diagnostics/performance.json' });
            for (const log of redactedLogs)
                archive.append(log.content, { name: `diagnostics/logs/${log.name}` });
            void archive.finalize();
        });
        this.logger.write('info', 'diagnostics.exported');
        return { path: destination };
    }
}
