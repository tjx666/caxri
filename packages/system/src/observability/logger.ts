import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { LogEventName, LogProcess } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import { once } from 'es-toolkit';

import type { CausalCapsule, CausalCapsuleInput } from './causal-chain.js';
import { BoundedCausalChain } from './causal-chain.js';
import type { ObservationContext } from './context.js';
import {
    currentObservationContext,
    mergeObservationContext,
    normalizeObservationContext,
} from './context.js';
import type {
    ObservationMetricLabels,
    ObservationMetricName,
    ObservationMetricRegistrySnapshot,
} from './metrics.js';
import { BoundedMetricRegistry } from './metrics.js';
import { isSecretKey, redactLogValue } from './redaction.js';

export { logEventCatalog };

/**
 * Native-process structured JSONL logger; never import from apps/desktop/src/renderer.
 */
export interface LogRecord {
    timestamp: string;
    process: LogProcess;
    level: 'debug' | 'info' | 'warn' | 'error';
    event: LogEventName;
    correlationId?: string;
    durationMs?: number;
    /**
     * Content-free opaque identities only; paths and prose are rejected by `normalizeObservationContext`.
     */
    context?: ObservationContext;
    /**
     * Stable failure classification; messages, stacks, payloads, paths, and environment values are unrepresentable.
     */
    failure?: CausalCapsule;
    /**
     * Structured detail values. These surface verbatim (minus secret-key/secret-pattern redaction) through
     * `logs.query`, the SecondarySidebar Logs panel, and `caxri logs` under the `diagnostics.read` capability, so the
     * diagnostics content boundary is enforced HERE, at the call site: never log source or file contents, Terminal
     * output, Agent prompts/transcripts, credentials, or environment values: log paths, counts, durations, error codes,
     * and identifiers instead.
     */
    fields?: Record<string, string | number | boolean | null>;
    /**
     * Build correlation, from `CAXRI_APP_VERSION`/`CAXRI_GIT_COMMIT`; omitted when unset.
     */
    appVersion?: string;
    commit?: string;
}

export interface LogWriteOptions extends Pick<
    LogRecord,
    'correlationId' | 'durationMs' | 'fields'
> {
    context?: ObservationContext;
    failure?: Omit<CausalCapsuleInput, 'context' | 'timestamp'>;
}

/**
 * Live-file ceiling before rotation. Sized against a `debug` default, which is what every Caxri process records unless
 * `CAXRI_LOG_LEVEL` says otherwise: per-request `ipc.request` records fill a 5MB file within hours of ordinary use, and
 * a log that rotated away the incident an agent was sent to investigate is the same as no log at all.
 *
 * Exported so the rotation tests can size their records against the live cap instead of restating it, which would make
 * them silently stop exercising rotation the next time this number moves.
 */
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
/**
 * Rotated generations kept alongside the live file (`.1` through `.3`, oldest last). Production evidence: with a single
 * generation, high-volume routine events (`agent.probe`, `pty.throughput`) rotated real incidents out of the log within
 * hours. Three generations (~80MB total per process log) buy meaningfully more retention while staying bounded; raising
 * it further is a tradeoff against disk usage, not a fix for noisy events, which the logging call sites should already
 * keep to 'debug'/'warn' as appropriate.
 */
export const MAX_LOG_GENERATIONS = 3;
/**
 * Backpressure bound: past this many queued bytes new records are dropped (and counted) instead of growing the heap
 * while the disk is unresponsive.
 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
/**
 * Events named in each `log.rotated` volume breakdown.
 */
const ROTATION_TOP_EVENTS = 5;
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
 * freezing the event loop: measured on Server Core's session-switch path, sync `appendFileSync` degrades from
 * microseconds to 30–100ms per call under moderate disk pressure and is unbounded under real IO stalls (issue #237).
 * Durability escape hatches: `error` records and process exit flush synchronously, so post-mortem evidence still
 * reaches disk even when the process dies on the next tick.
 */
export class StructuredLogger {
    private readonly causalChain = new BoundedCausalChain();
    private readonly metrics = new BoundedMetricRegistry();
    private bytesWritten: number;
    private pendingLines: string[] = [];
    private pendingBytes = 0;
    private droppedRecords = 0;
    /**
     * Records written per event since the live file was last rotated (or since process start when the file predates
     * it). Bounded by the event catalog, so it needs no eviction. Counted at `write()`, so the batch whose size
     * triggered a rotation is attributed to the generation it closed; the breakdown is a volume signal, not a ledger.
     */
    private eventCounts = new Map<LogEventName, number>();
    private eventCountsSince = Date.now();
    private eventCountsFromRotation = false;
    private drainPromise?: Promise<void>;
    /**
     * Bumped by `flushSync` so a concurrent drain knows its batch was already written and cleared.
     */
    private generation = 0;
    /**
     * Read once at construction, not per-write, since the build stamp never changes at runtime.
     */
    private readonly appVersion?: string;
    private baseContext: ObservationContext;
    private readonly commit?: string;
    private readonly directory: string;
    readonly path: string;

    constructor(
        logDirectory: string,
        private readonly processName: LogRecord['process'] = 'server-core',
        private readonly minimumLevel: LogRecord['level'] = 'debug',
        baseContext: ObservationContext = {},
    ) {
        // oxlint-disable-next-line node/no-sync -- deliberate: must exist before the first flush below.
        mkdirSync(logDirectory, { recursive: true });
        this.directory = logDirectory;
        this.path = join(logDirectory, `${processName}.jsonl`);
        this.baseContext = normalizeObservationContext({ processId: process.pid, ...baseContext });
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
            /**
             * Rotation is deliberately synchronous even on the async path: it is a rare (per-5MiB) pair of rename/rm
             * calls, and an `await` window between the rotate decision and its execution would let a concurrent
             * `flushSync` append to the not-yet-rotated file and permanently drift `bytesWritten`.
             */
            // oxlint-disable-next-line node/no-sync -- deliberate: rotation must be atomic with its decision, see above.
            this.rotateIfNeededSync(batch.byteCount);
            await appendFile(this.path, batch.text, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            /**
             * Logging is best-effort: the log directory can legitimately vanish while the process is still running
             * (profile teardown racing a late async callback, uninstall/reset tooling). Recreate it and retry once; if
             * the retry still fails, drop the batch instead of throwing into an arbitrary call site, a lost log line
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
                event: logEventCatalog.log.recordsDropped,
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
     * propagate: silently appending past the cap would grow without bound.
     */
    private rotateIfNeededSync(incomingBytes: number): void {
        if (this.bytesWritten + incomingBytes <= MAX_LOG_BYTES) return;
        const rotatedBytes = this.bytesWritten;
        this.bytesWritten = 0;
        /**
         * Shift oldest-to-newest (`.2` -> `.3`, `.1` -> `.2`, live -> `.1`) so a mid-shift crash never loses a
         * generation to a half-completed swap: each rename source is only ever read before it becomes a target.
         */
        const oldestPath = `${this.path}.${MAX_LOG_GENERATIONS}`;
        // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
        rmSync(oldestPath, { force: true });
        for (let generation = MAX_LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
            const source = `${this.path}.${generation}`;
            const target = `${this.path}.${generation + 1}`;
            try {
                // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
                renameSync(source, target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate: crash/exit path must not await.
            renameSync(this.path, `${this.path}.1`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // oxlint-disable-next-line node/no-sync -- deliberate: part of the synchronous rotation step above.
        this.writeRotationSummarySync(rotatedBytes);
    }

    /**
     * Opens every new generation with the volume breakdown of the one it replaced. A single runaway event (a watcher
     * feedback loop, a per-byte trace) otherwise stays invisible until someone hand-counts a rotated file, while it
     * silently shortens how far back every other record survives. `generationMs` is how long the file lasted;
     * `topEvents` names the events that filled it, as `event:records` pairs, loudest first.
     */
    private writeRotationSummarySync(rotatedBytes: number): void {
        const counts = [...this.eventCounts].toSorted((left, right) => right[1] - left[1]);
        const records = counts.reduce((total, [, count]) => total + count, 0);
        const record: LogRecord = {
            timestamp: new Date().toISOString(),
            process: this.processName,
            level: 'info',
            event: logEventCatalog.log.rotated,
            fields: {
                rotatedBytes,
                records,
                generationMs: Date.now() - this.eventCountsSince,
                countedFrom: this.eventCountsFromRotation ? 'rotation' : 'processStart',
                topEvents: counts
                    .slice(0, ROTATION_TOP_EVENTS)
                    .map(([event, count]) => `${event}:${count}`)
                    .join(','),
                topEventShare: records > 0 ? Math.round((counts[0][1] / records) * 100) : 0,
            },
            appVersion: this.appVersion,
            commit: this.commit,
        };
        this.eventCounts = new Map();
        this.eventCountsSince = Date.now();
        this.eventCountsFromRotation = true;
        const line = `${JSON.stringify(record)}\n`;
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate: runs inside the synchronous rotation step.
            appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
            this.bytesWritten += Buffer.byteLength(line, 'utf8');
        } catch {
            /**
             * The summary is diagnostic garnish; the batch append that follows owns directory recreation and failure.
             */
        }
    }

    /**
     * Adds process identities discovered after logger construction, such as the build fingerprint and durable Server
     * identity. The same content-free normalizer applies, and the real process id cannot be replaced by callers.
     */
    updateBaseContext(context: ObservationContext): void {
        this.baseContext = mergeObservationContext(this.baseContext, context, {
            processId: process.pid,
        });
    }

    write(level: LogRecord['level'], event: LogEventName, options: LogWriteOptions = {}): void {
        if (LOG_LEVELS[level] < LOG_LEVELS[this.minimumLevel]) return;
        const context = mergeObservationContext(
            this.baseContext,
            options.correlationId
                ? { requestId: options.correlationId, traceId: options.correlationId }
                : undefined,
            currentObservationContext(),
            options.context,
        );
        const failure = options.failure
            ? this.causalChain.record({
                  ...options.failure,
                  context,
              })
            : undefined;
        const record: LogRecord = {
            timestamp: new Date().toISOString(),
            process: this.processName,
            level,
            event,
            correlationId: options.correlationId,
            durationMs: options.durationMs,
            ...(Object.keys(context).length > 0 && { context }),
            ...(failure && { failure }),
            fields: safeFields(options.fields),
            appVersion: this.appVersion,
            commit: this.commit,
        };
        this.enqueue(`${JSON.stringify(record)}\n`);
        this.eventCounts.set(event, (this.eventCounts.get(event) ?? 0) + 1);
        /**
         * Errors are post-mortem evidence: the process may die on the next tick (crash handlers log then exit), so the
         * rare synchronous stall is worth the guaranteed durability. Everything else drains asynchronously.
         */
        // oxlint-disable-next-line node/no-sync -- deliberate: error records must be durable before the next tick.
        if (level === 'error') this.flushSync();
        else this.scheduleDrain();
    }

    recordMetric(
        name: ObservationMetricName,
        value: number,
        labels: ObservationMetricLabels,
    ): void {
        this.metrics.record(name, value, labels);
    }

    metricSnapshot(): ObservationMetricRegistrySnapshot {
        return this.metrics.snapshot();
    }

    causalSnapshot(traceId?: string): CausalCapsule[] {
        return this.causalChain.snapshot(traceId);
    }

    /**
     * Resolves once every record enqueued before the call is on disk. For tests and graceful shutdown.
     */
    async flush(): Promise<void> {
        if (!this.drainPromise && !this.hasWork()) return;
        this.scheduleDrain();
        await this.drainPromise;
        /**
         * Records enqueued while that drain ran (or a drain a concurrent caller started) still need a pass; recursion
         * depth is bounded by the number of interleaving writers, not queue size.
         */
        return this.flush();
    }

    /**
     * Synchronous last-resort drain for `error` records and the process exit hook. Pending lines stay queued until an
     * append succeeds, so this can flush everything: including a batch whose async append is still in flight. If that
     * append later completes too, the batch lands twice in the file; `logs.query` identifies records by content hash,
     * so duplicates collapse there and only raw `tail` output shows them. Losing an in-flight batch at exit would be
     * worse than the duplicate.
     */
    flushSync(): void {
        const batch = this.composeBatch();
        if (!batch) return;
        /**
         * Settle only after the append lands (mirroring `drainOnce`): a non-ENOENT failure below propagates with the
         * batch still queued, so the async drain gets its own shot at it instead of the records silently vanishing. The
         * ENOENT retry failing adopts the drain path's drop semantics.
         */
        const settleBatch = (): void => {
            this.generation += 1;
            this.pendingLines = [];
            this.pendingBytes = 0;
        };
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
                settleBatch();
                return;
            }
        }
        this.bytesWritten += batch.byteCount;
        settleBatch();
    }
}
