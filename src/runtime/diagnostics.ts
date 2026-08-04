import { createWriteStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ZipArchive } from 'archiver';

import type { AppSettings } from '../shared/types';
import type { CaxriDatabase } from './database';
import { redactLogValue, type StructuredLogger } from './logger';

const SECRET_KEY = /(token|password|secret|credential|api[_-]?key|authorization|cookie)/i;
export function normalizeHome(path: string): string {
    const home = homedir();
    return path === home
        ? '$HOME'
        : path.startsWith(`${home}/`)
          ? `$HOME/${path.slice(home.length + 1)}`
          : path;
}

export function redactSecrets(value: unknown, key = ''): unknown {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, child]) => [
                childKey,
                redactSecrets(child, childKey),
            ]),
        );
    }
    if (typeof value === 'string') {
        return value
            .replaceAll(homedir(), '$HOME')
            .replace(/(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]+)/g, '[REDACTED]');
    }
    return value;
}

function json(value: unknown): string {
    return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}

export class DiagnosticsService {
    constructor(
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly getSettings: () => AppSettings,
        private readonly activePtyCount: () => number,
        private readonly startedAt: number,
    ) {}

    async export(destination: string): Promise<{ path: string }> {
        const sessions = this.database.listSessions().map((session) => ({
            id: session.id,
            rootPath: normalizeHome(session.rootPath),
            createdAt: session.createdAt,
            lastOpenedAt: session.lastOpenedAt,
            lastActivityState: session.lastActivityState,
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
        const logNames = (await readdir(logDirectory)).filter((name) => name.endsWith('.jsonl'));
        const redactedLogs = await Promise.all(
            logNames.map(async (name) => ({
                name,
                content: redactLogValue(await readFile(join(logDirectory, name), 'utf8')),
            })),
        );

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
            archive.append(json(sessions), { name: 'diagnostics/sessions.json' });
            archive.append(json(terminals), { name: 'diagnostics/terminals.json' });
            archive.append(json(this.getSettings()), { name: 'diagnostics/settings.json' });
            archive.append(json({ note: 'Performance events are available in structured logs.' }), {
                name: 'diagnostics/performance.json',
            });
            for (const log of redactedLogs)
                archive.append(log.content, { name: `diagnostics/logs/${log.name}` });
            void archive.finalize();
        });
        this.logger.write('info', 'diagnostics.exported');
        return { path: destination };
    }
}
