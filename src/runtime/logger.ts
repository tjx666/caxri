import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LogRecord {
    timestamp: string;
    process: 'main' | 'runtime';
    level: 'debug' | 'info' | 'warn' | 'error';
    event: string;
    correlationId?: string;
    durationMs?: number;
    fields?: Record<string, string | number | boolean | null>;
}

const SECRET_KEY = /(token|password|secret|credential|api[_-]?key|authorization|cookie)/i;
const SECRET_ASSIGNMENT =
    /\b(token|password|secret|credential|api[_-]?key|authorization|cookie)\s*[=:]\s*([^\s,;]+)/gi;
const SECRET_VALUE =
    /(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]+|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})/g;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_LEVELS: Record<LogRecord['level'], number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export function redactLogValue(value: string): string {
    return value
        .replaceAll(homedir(), '$HOME')
        .replace(SECRET_VALUE, '[REDACTED]')
        .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

function safeFields(fields?: LogRecord['fields']): LogRecord['fields'] {
    if (!fields) return undefined;
    return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
            key,
            SECRET_KEY.test(key)
                ? '[REDACTED]'
                : typeof value === 'string'
                  ? redactLogValue(value)
                  : value,
        ]),
    );
}

export class StructuredLogger {
    readonly path: string;
    private bytesWritten: number;

    constructor(
        logDirectory: string,
        private readonly processName: LogRecord['process'] = 'runtime',
        private readonly minimumLevel: LogRecord['level'] = 'debug',
    ) {
        mkdirSync(logDirectory, { recursive: true });
        this.path = join(logDirectory, `${processName}.jsonl`);
        try {
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
        };
        const line = `${JSON.stringify(record)}\n`;
        if (this.bytesWritten + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
            const rotatedPath = `${this.path}.1`;
            rmSync(rotatedPath, { force: true });
            try {
                renameSync(this.path, rotatedPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            this.bytesWritten = 0;
        }
        appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
        this.bytesWritten += Buffer.byteLength(line, 'utf8');
    }
}
