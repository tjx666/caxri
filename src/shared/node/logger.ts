import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { once } from 'es-toolkit';

import { isSecretKey, redactLogValue } from './redaction';

/**
 * Node-only structured JSONL logger; never import from src/renderer.
 */
export interface LogRecord {
    timestamp: string;
    process: 'host' | 'main' | 'runtime';
    level: 'debug' | 'info' | 'warn' | 'error';
    event: string;
    correlationId?: string;
    durationMs?: number;
    /**
     * Structured detail values. These surface verbatim (minus secret-key/secret-pattern redaction) through
     * `logs.query`, the Inspector Logs panel, and `caxri logs` under the `diagnostics.read` capability, so the
     * diagnostics content boundary is enforced HERE, at the call site: never log source or file contents, Terminal
     * output, Agent prompts/transcripts, credentials, or environment values — log paths, counts, durations, error
     * codes, and identifiers instead.
     */
    fields?: Record<string, string | number | boolean | null>;
    /**
     * Build correlation, from `CAXRI_APP_VERSION`/`CAXRI_GIT_COMMIT`; omitted when unset.
     */
    appVersion?: string;
    commit?: string;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
/**
 * Backpressure bound: past this many queued bytes new records are dropped (and counted) instead of growing the heap
 * while the disk is unresponsive.
 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const LOG_LEVELS: Record<LogRecord['level'], number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function safeFields(fields?: LogRecord['fields']): LogRecord['fields'] {
    if (!fields) return undefined;
    return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
            key,
            isSecretKey(key)
                ? '[REDACTED]'
                : typeof value === 'string'
                  ? redactLogValue(value)
                  : value,
        ]),
    );
}

/**
 * One process-level exit hook flushes every live logger; per-instance `process.on('exit')` listeners would accumulate
 * across construction (tests build many loggers) and trip the max-listeners warning.
 */
const liveLoggers = new Set<StructuredLogger>();

const installExitHook = once(() => {
    process.on('exit', () => {
        // oxlint-disable-next-line node/no-sync -- deliberate: the exit hook cannot await; see flushSync's doc.
        for (const logger of liveLoggers) logger.flushSync();
    });
});

/**
 * Buffered asynchronous JSONL writer. `write()` only enqueues; a single in-flight drain appends batches with
 * `fs/promises`, so a stalled disk (swap storms, Spotlight, APFS snapshots) backs records up in memory instead of
 * freezing the event loop — measured on the Runtime's session-switch path, sync `appendFileSync` degrades from
 * microseconds to 30–100ms per call under moderate disk pressure and is unbounded under real IO stalls (issue #237).
 * Durability escape hatches: `error` records and process exit flush synchronously, so post-mortem evidence still
 * reaches disk even when the process dies on the next tick.
 */
export class StructuredLogger {
    private bytesWritten: number;
    private pendingLines: string[] = [];
    private pendingBytes = 0;
    private droppedRecords = 0;
    private drainPromise?: Promise<void>;
    /**
     * Bumped by `flushSync` so a concurrent drain knows its batch was already written and cleared.
     */
    private generation = 0;
    /**
     * Read once at construction, not per-write, since the build stamp never changes at runtime.
     */
    private readonly appVersion?: string;
    private readonly commit?: string;
    private readonly directory: string;
    readonly path: string;

    constructor(
        logDirectory: string,
        private readonly processName: LogRecord['process'] = 'runtime',
        private readonly minimumLevel: LogRecord['level'] = 'debug',
    ) {
        // oxlint-disable-next-line node/no-sync -- deliberate: must exist before the first flush below.
        mkdirSync(logDirectory, { recursive: true });
        this.directory = logDirectory;
        this.path = join(logDirectory, `${processName}.jsonl`);
        // `||` (not `??`) is deliberate: an env var explicitly set to `''` should also collapse to
        // "unknown" rather than being logged as an empty-string version/commit.
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also fall through to undefined
        this.appVersion = process.env.CAXRI_APP_VERSION || undefined;
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also fall through to undefined
        this.commit = process.env.CAXRI_GIT_COMMIT || undefined;
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate startup boundary before the first write.
            this.bytesWritten = statSync(this.path).size;
        } catch {
            this.bytesWritten = 0;
        }
        liveLoggers.add(this);
        installExitHook();
    }

    private hasWork(): boolean {
        return this.pendingLines.length > 0 || this.droppedRecords > 0;
    }

    private enqueue(line: string): void {
        if (this.pendingBytes >= MAX_PENDING_BYTES) {
            this.droppedRecords += 1;
            return;
        }
        this.pendingLines.push(line);
        this.pendingBytes += Buffer.byteLength(line, 'utf8');
    }

    private scheduleDrain(): void {
        this.drainPromise ??= (async () => {
            try {
                await this.drain();
            } catch (error) {
                /**
                 * The synchronous logger surfaced rotation failures to the `write()` caller; the async drain has no
                 * caller to throw into, and an unhandled rejection here would crash the whole process over a log file.
                 */
                console.error('StructuredLogger drain failed', error);
            } finally {
                this.drainPromise = undefined;
                if (this.hasWork()) this.scheduleDrain();
            }
        })();
    }

    private async drain(): Promise<void> {
        while (this.hasWork()) {
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential: batches must append in order.
            if (!(await this.drainOnce())) return;
        }
    }

    /**
     * Appends one batch; returns false when nothing remains to write or the batch had to be dropped.
     */
    private async drainOnce(): Promise<boolean> {
        const batch = this.composeBatch();
        if (!batch) return false;
        const generation = this.generation;
        const settleBatch = (): void => {
            /**
             * A `flushSync` during the awaits above already wrote and cleared these lines (bumping the generation);
             * splicing then would remove records enqueued after the flush.
             */
            if (generation !== this.generation) return;
            this.pendingLines.splice(0, batch.lineCount);
            this.pendingBytes -= batch.byteCount;
        };
        try {
            await this.rotateIfNeeded(batch.byteCount);
            await appendFile(this.path, batch.text, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            /**
             * Logging is best-effort: the log directory can legitimately vanish while the process is still running
             * (profile teardown racing a late async callback, uninstall/reset tooling). Recreate it and retry once; if
             * the retry still fails, drop the batch instead of throwing into an arbitrary call site — a lost log line
             * must never crash a watcher or become an unhandled rejection. Non-transient failures also drop the batch
             * before propagating: retrying the same doomed batch would spin the drain loop forever.
             */
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                settleBatch();
                throw error;
            }
            try {
                await mkdir(this.directory, { recursive: true });
                await appendFile(this.path, batch.text, { encoding: 'utf8', mode: 0o600 });
            } catch {
                settleBatch();
                return false;
            }
        }
        this.bytesWritten += batch.byteCount;
        settleBatch();
        return true;
    }

    /**
     * Snapshots the queue front without removing it; the caller settles the batch only after the append succeeds so a
     * crash-time `flushSync` still sees (and persists) it. Also materializes the pending drop counter into a `warn`
     * record so backpressure losses stay visible.
     */
    private composeBatch(): { text: string; byteCount: number; lineCount: number } | undefined {
        if (this.droppedRecords > 0) {
            const record: LogRecord = {
                timestamp: new Date().toISOString(),
                process: this.processName,
                level: 'warn',
                event: 'log.records_dropped',
                fields: { droppedRecords: this.droppedRecords },
                appVersion: this.appVersion,
                commit: this.commit,
            };
            this.droppedRecords = 0;
            const line = `${JSON.stringify(record)}\n`;
            this.pendingLines.push(line);
            this.pendingBytes += Buffer.byteLength(line, 'utf8');
        }
        if (this.pendingLines.length === 0) return undefined;
        const text = this.pendingLines.join('');
        return {
            text,
            byteCount: Buffer.byteLength(text, 'utf8'),
            lineCount: this.pendingLines.length,
        };
    }

    /**
     * Rotation must complete before the append that would overflow. Rotation failures other than a missing source
     * propagate — silently appending past the cap would grow without bound.
     */
    private async rotateIfNeeded(incomingBytes: number): Promise<void> {
        if (this.bytesWritten + incomingBytes <= MAX_LOG_BYTES) return;
        this.bytesWritten = 0;
        const rotatedPath = `${this.path}.1`;
        await rm(rotatedPath, { force: true });
        try {
            await rename(this.path, rotatedPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    private rotateIfNeededSync(incomingBytes: number): void {
        if (this.bytesWritten + incomingBytes <= MAX_LOG_BYTES) return;
        this.bytesWritten = 0;
        const rotatedPath = `${this.path}.1`;
        // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
        rmSync(rotatedPath, { force: true });
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
            renameSync(this.path, rotatedPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    write(
        level: LogRecord['level'],
        event: string,
        options: Pick<LogRecord, 'correlationId' | 'durationMs' | 'fields'> = {},
    ): void {
        if (LOG_LEVELS[level] < LOG_LEVELS[this.minimumLevel]) return;
        const record: LogRecord = {
            timestamp: new Date().toISOString(),
            process: this.processName,
            level,
            event,
            correlationId: options.correlationId,
            durationMs: options.durationMs,
            fields: safeFields(options.fields),
            appVersion: this.appVersion,
            commit: this.commit,
        };
        this.enqueue(`${JSON.stringify(record)}\n`);
        /**
         * Errors are post-mortem evidence: the process may die on the next tick (crash handlers log then exit), so the
         * rare synchronous stall is worth the guaranteed durability. Everything else drains asynchronously.
         */
        // oxlint-disable-next-line node/no-sync -- deliberate: error records must be durable before the next tick.
        if (level === 'error') this.flushSync();
        else this.scheduleDrain();
    }

    /**
     * Resolves once every record enqueued before the call is on disk. For tests and graceful shutdown.
     */
    async flush(): Promise<void> {
        while (this.drainPromise || this.hasWork()) {
            this.scheduleDrain();
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each pass awaits the current drain.
            await this.drainPromise;
        }
    }

    /**
     * Synchronous last-resort drain for `error` records and the process exit hook. Pending lines stay queued until an
     * append succeeds, so this can flush everything — including a batch whose async append is still in flight. If that
     * append later completes too, the batch lands twice in the file; `logs.query` identifies records by content hash,
     * so duplicates collapse there and only raw `tail` output shows them. Losing an in-flight batch at exit would be
     * worse than the duplicate.
     */
    flushSync(): void {
        const batch = this.composeBatch();
        if (!batch) return;
        this.generation += 1;
        this.pendingLines = [];
        this.pendingBytes = 0;
        // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
        this.rotateIfNeededSync(batch.byteCount);
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
            appendFileSync(this.path, batch.text, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try {
                // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
                mkdirSync(this.directory, { recursive: true });
                // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
                appendFileSync(this.path, batch.text, { encoding: 'utf8', mode: 0o600 });
            } catch {
                return;
            }
        }
        this.bytesWritten += batch.byteCount;
    }
}
