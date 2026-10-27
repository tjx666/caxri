import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings, diagnosticsSnapshotSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { execFileAsync } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../db';
import { DiagnosticsService } from '../diagnostics';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-diagnostics-performance-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const logDirectory = join(directory, 'logs');
    await mkdir(logDirectory);
    const line = (event: string, durationMs: number, fields: Record<string, unknown>) =>
        JSON.stringify({
            timestamp: '2026-10-27T08:00:00.000Z',
            process: 'server-core',
            level: 'debug',
            event,
            durationMs,
            fields,
        });
    await writeFile(
        join(logDirectory, 'server-core.jsonl'),
        [
            line('ipc.request', 40, { method: 'session.select', principal: 'desktop' }),
            line('ipc.request', 12, { method: 'session.select' }),
            line('git.command', 6, { operation: 'status', repository: 'abc123' }),
            line('files.list', 3, {}),
        ].join('\n'),
    );
    const diagnostics = new DiagnosticsService(
        database,
        {
            path: join(logDirectory, 'server-core.jsonl'),
            write: () => {},
        } as unknown as StructuredLogger,
        () => defaultAppSettings,
        () => 0,
        1,
    );
    return { diagnostics, directory };
}

describe('diagnostics performance rows', () => {
    it('are the same keyed rows in the snapshot and in the export', async () => {
        const { diagnostics, directory } = await fixture();

        const snapshot = diagnosticsSnapshotSchema.parse(await diagnostics.snapshot());
        const archive = join(directory, 'diagnostics.zip');
        await diagnostics.export(archive);
        const { stdout } = await execFileAsync('unzip', [
            '-p',
            archive,
            'diagnostics/performance.json',
        ]);

        expect(
            snapshot.performance.map(({ event, key, boundary }) => [event, key, boundary]),
        ).toEqual([
            ['ipc.request', 'session.select', 'relay'],
            ['ipc.request', 'session.select', 'handler'],
            ['git.command', 'status', undefined],
            ['files.list', undefined, undefined],
        ]);
        expect(JSON.parse(stdout)).toEqual(snapshot.performance);
    });
});
