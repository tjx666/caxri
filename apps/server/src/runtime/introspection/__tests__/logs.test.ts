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
            join(directory, 'runtime.jsonl'),
            [
                JSON.stringify({
                    timestamp: '2026-08-14T00:00:00.000Z',
                    process: 'runtime',
                    level: 'info',
                    event: 'runtime.ready',
                    durationMs: 12,
                    fields: { source: 'private.ts', token: 'secret-sentinel' },
                }),
                'truncated-json',
                JSON.stringify({
                    timestamp: '2026-08-14T00:00:01.000Z',
                    process: 'runtime',
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
                process: 'runtime',
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
                process: 'host',
                level: 'info',
                event: `host.event.${index}`,
            }),
        );
        await writeFile(join(directory, 'host.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
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
        const path = join(directory, 'runtime.jsonl');
        await writeFile(
            path,
            `${JSON.stringify({
                timestamp: '2026-08-14T00:00:00.000Z',
                process: 'runtime',
                level: 'info',
                event: 'runtime.ready',
            })}\n`,
            { mode: 0o600 },
        );
        const service = new LogQueryService(directory);
        const before = await service.query({ limit: 10 });

        await rename(path, `${path}.1`);
        const after = await service.query({ limit: 10 });

        expect(after.records[0]?.id).toBe(before.records[0]?.id);
    });
});
