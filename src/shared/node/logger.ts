import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

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

export class StructuredLogger {
    private bytesWritten: number;
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
        // oxlint-disable-next-line node/no-sync -- deliberate: must exist before the first synchronous write() below.
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
            // oxlint-disable-next-line node/no-sync -- deliberate: this logger is synchronous by design, see class doc.
            this.bytesWritten = statSync(this.path).size;
        } catch {
            this.bytesWritten = 0;
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
        const line = `${JSON.stringify(record)}\n`;
        if (this.bytesWritten + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
            const rotatedPath = `${this.path}.1`;
            // oxlint-disable-next-line node/no-sync -- deliberate: rotation must finish before the write() below.
            rmSync(rotatedPath, { force: true });
            try {
                // oxlint-disable-next-line node/no-sync -- deliberate: see the class doc comment above.
                renameSync(this.path, rotatedPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            this.bytesWritten = 0;
        }
        try {
            // oxlint-disable-next-line node/no-sync -- deliberate: synchronous by design, durable the instant this returns.
            appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            /**
             * Logging is best-effort: the log directory can legitimately vanish while the process is still running
             * (profile teardown racing a late async callback, uninstall/reset tooling). Recreate it and retry once; if
             * the retry still fails, drop the record instead of throwing into an arbitrary call site — a lost log line
             * must never crash a watcher or become an unhandled rejection.
             */
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try {
                // oxlint-disable-next-line node/no-sync -- deliberate: same synchronous recovery path as the write above.
                mkdirSync(this.directory, { recursive: true });
                // oxlint-disable-next-line node/no-sync -- deliberate: see the class doc comment above.
                appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
            } catch {
                return;
            }
        }
        this.bytesWritten += Buffer.byteLength(line, 'utf8');
    }
}
