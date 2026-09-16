import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LogQueryService } from '../logs';

describe('bounded structured log queries', () => {
    it('returns allowlisted metadata, filters records, and ignores malformed lines', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-log-query-'));
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, 'server-core.jsonl'),
            [
                JSON.stringify({
                    timestamp: '2026-08-14T00:00:00.000Z',
                    process: 'server-core',
                    level: 'info',
                    event: 'server_core.ready',
                    durationMs: 12,
                    fields: { source: 'private.ts', token: 'secret-sentinel' },
                }),
                'truncated-json',
                JSON.stringify({
                    timestamp: '2026-08-14T00:00:01.000Z',
                    process: 'server-core',
                    level: 'error',
                    event: 'ipc.request_failed',
                    correlationId: 'request-1',
                    fields: { prompt: 'private prompt' },
                }),
                '',
            ].join('\n'),
            { mode: 0o600 },
        );

        const result = await new LogQueryService(directory).query({ level: 'error', limit: 10 });

        expect(result.records).toEqual([
            expect.objectContaining({
                timestamp: '2026-08-14T00:00:01.000Z',
                process: 'server-core',
                level: 'error',
                event: 'ipc.request_failed',
                correlationId: 'request-1',
                fields: { prompt: 'private prompt' },
            }),
        ]);
        expect(result.nextCursor).toBeTruthy();

        // Structured fields surface for the log viewer, but a line written outside `StructuredLogger` still gets the
        // same secret redaction applied at read time.
        const infoResult = await new LogQueryService(directory).query({ level: 'info', limit: 10 });
        expect(infoResult.records[0]?.fields).toEqual({
            source: 'private.ts',
            token: '[REDACTED]',
        });
        expect(JSON.stringify(infoResult)).not.toContain('secret-sentinel');
    });

    it('reports a gap for a cursor older than the bounded readable suffix', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-log-gap-'));
        const lines = Array.from({ length: 150 }, (_, index) =>
            JSON.stringify({
                timestamp: new Date(Date.UTC(2026, 7, 14, 0, 0, index)).toISOString(),
                process: 'server-core',
                level: 'info',
                event: `host.event.${index}`,
            }),
        );
        await writeFile(join(directory, 'server-core.jsonl'), `${lines.join('\n')}\n`, {
            mode: 0o600,
        });
        const service = new LogQueryService(directory, { maximumRecords: 32 });

        const result = await service.query({
            afterCursor: '2020-01-01T00:00:00.000Z\t000000000000000000000000',
            limit: 10,
        });

        expect(result.gap).toBe(true);
        expect(result.records).toHaveLength(10);
        expect(result.truncated).toBe(true);
    });

    it('keeps cursor identities stable when the structured logger rotates a file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-log-rotation-'));
        const path = join(directory, 'server-core.jsonl');
        await writeFile(
            path,
            `${JSON.stringify({
                timestamp: '2026-08-14T00:00:00.000Z',
                process: 'server-core',
                level: 'info',
                event: 'server_core.ready',
            })}\n`,
            { mode: 0o600 },
        );
        const service = new LogQueryService(directory);
        const before = await service.query({ limit: 10 });

        await rename(path, `${path}.1`);
        const after = await service.query({ limit: 10 });

        expect(after.records[0]?.id).toBe(before.records[0]?.id);
    });

    it('collapses identical lines duplicated by an exit flush or rotation boundary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-log-duplicate-'));
        const line = JSON.stringify({
            timestamp: '2026-08-14T00:00:00.000Z',
            process: 'desktop',
            level: 'error',
            event: 'renderer.console_error',
            fields: { code: 'CONSOLE_ERROR' },
        });
        await writeFile(join(directory, 'desktop.jsonl'), `${line}\n${line}\n`, { mode: 0o600 });
        await writeFile(join(directory, 'desktop.jsonl.1'), `${line}\n`, { mode: 0o600 });

        const result = await new LogQueryService(directory).query({ limit: 10 });

        expect(result.records).toHaveLength(1);
        expect(result.records[0]?.event).toBe('renderer.console_error');
    });

    it('reads records from every rotated generation, not just `.1`', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-log-generations-'));
        const record = (event: string, second: number) =>
            `${JSON.stringify({
                timestamp: `2026-08-14T00:00:${String(second).padStart(2, '0')}.000Z`,
                process: 'server-core',
                level: 'info',
                event,
            })}\n`;
        await writeFile(join(directory, 'server-core.jsonl'), record('server_core.ready', 3), {
            mode: 0o600,
        });
        await writeFile(join(directory, 'server-core.jsonl.1'), record('server_core.first', 2), {
            mode: 0o600,
        });
        await writeFile(join(directory, 'server-core.jsonl.2'), record('server_core.second', 1), {
            mode: 0o600,
        });
        await writeFile(join(directory, 'server-core.jsonl.3'), record('server_core.third', 0), {
            mode: 0o600,
        });

        const result = await new LogQueryService(directory).query({ limit: 10 });

        expect(result.records.map((entry) => entry.event)).toEqual([
            'server_core.third',
            'server_core.second',
            'server_core.first',
            'server_core.ready',
        ]);
    });
});
