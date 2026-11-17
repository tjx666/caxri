import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { execFileAsync } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../db';
import { DiagnosticsService } from '../diagnostics';
import { DIAGNOSTIC_LOG_TAIL_BYTES } from '../diagnostics-logs';

const record = (event: string, level: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({
        timestamp: '2026-11-18T08:00:00.000Z',
        process: 'server-core',
        level,
        event,
        fields,
    });

const errorLine = (timestamp: string, correlationId: string) =>
    JSON.stringify({
        timestamp,
        process: 'server-core',
        level: 'error',
        event: 'ipc.failed',
        correlationId,
    });

/**
 * A profile whose server-core log is far larger than the diagnostics tail cap: an old error at the very start, filler
 * past the cap, and a recent error at the end.
 */
async function oversizedFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-diagnostics-bounds-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const logDirectory = join(directory, 'logs');
    await mkdir(logDirectory);
    const filler = record('files.list', 'debug', { padding: 'x'.repeat(900) });
    const fillerLines = Math.ceil((DIAGNOSTIC_LOG_TAIL_BYTES * 3) / (filler.length + 1));
    const path = join(logDirectory, 'server-core.jsonl');
    await writeFile(
        path,
        [
            errorLine('2026-11-18T07:00:00.000Z', 'old-error'),
            ...Array.from({ length: fillerLines }, () => filler),
            errorLine('2026-11-18T09:00:00.000Z', 'recent-error'),
            '',
        ].join('\n'),
    );
    const diagnostics = new DiagnosticsService(
        database,
        { path, write: () => {} } as unknown as StructuredLogger,
        () => defaultAppSettings,
        () => 0,
        1,
    );
    return { diagnostics, directory, filler, fillerLines };
}

describe('diagnostics log reads', () => {
    it('reportContext and snapshot read only the log tail and still find the recent error', async () => {
        const { diagnostics } = await oversizedFixture();

        const { recentErrorIds } = await diagnostics.reportContext();
        const snapshot = await diagnostics.snapshot();

        // The old error sits before the cap, so a bounded read cannot see it; the recent one is in the tail.
        expect(recentErrorIds).toEqual(['server-core:recent-error']);
        expect(snapshot.recentErrorIds).toEqual(['server-core:recent-error']);
    });

    it('exports every log line, redacted, without truncating to the tail cap', async () => {
        const { diagnostics, directory, fillerLines } = await oversizedFixture();
        const secretLog = join(directory, 'logs', 'desktop.jsonl');
        await writeFile(
            secretLog,
            `${record('app.ready', 'info', { note: 'token=abc123secret' })}\n${record('app.tail', 'info')}`,
        );

        const archive = join(directory, 'diagnostics.zip');
        await diagnostics.export(archive);
        const server = await execFileAsync(
            'unzip',
            ['-p', archive, 'diagnostics/logs/server-core.jsonl'],
            {
                maxBuffer: 64 * 1024 * 1024,
            },
        );
        const desktop = await execFileAsync('unzip', [
            '-p',
            archive,
            'diagnostics/logs/desktop.jsonl',
        ]);

        expect(server.stdout.split('\n').filter(Boolean)).toHaveLength(fillerLines + 2);
        expect(server.stdout).toContain('old-error');
        expect(desktop.stdout).not.toContain('abc123secret');
        expect(desktop.stdout).toContain('[REDACTED]');
        // A file without a trailing newline keeps its last record intact.
        expect(desktop.stdout.endsWith(record('app.tail', 'info'))).toBe(true);
    });
});
