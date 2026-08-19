import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { StructuredLogger } from '../logger';

describe('StructuredLogger', () => {
    it('skips verbose records below the configured production threshold', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory, 'runtime', 'info');
            logger.write('debug', 'ignored');
            logger.write('info', 'kept');
            await logger.flush();

            expect(await readFile(logger.path, 'utf8')).not.toContain('ignored');
            expect(await readFile(logger.path, 'utf8')).toContain('kept');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('recreates a deleted log directory instead of throwing into the caller', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', 'before-removal');
            await logger.flush();

            // Profile teardown (or uninstall tooling) can delete the log directory while a late
            // async callback still logs; that write must be best-effort, never an exception.
            await rm(directory, { recursive: true, force: true });
            expect(() => logger.write('warn', 'after-removal')).not.toThrow();
            await logger.flush();

            expect(await readFile(logger.path, 'utf8')).toContain('after-removal');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps write() off the disk: records land only after the async drain', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', 'buffered');
            // Regression for issue #237: the sync logger's appendFileSync per record froze the
            // event loop whenever the disk stalled; write() must now enqueue without touching fs.
            // Checked synchronously — awaiting a read would race the async drain, which may land
            // the record before the read resolves.
            expect(existsSync(logger.path)).toBe(false);
            await logger.flush();
            expect(await readFile(logger.path, 'utf8')).toContain('buffered');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('flushes error records synchronously so post-mortem evidence survives an immediate exit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', 'queued-before-crash');
            logger.write('error', 'crash');

            // No flush(): both records must already be durable the instant write('error') returns.
            const content = await readFile(logger.path, 'utf8');
            expect(content).toContain('queued-before-crash');
            expect(content).toContain('crash');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('drops records past the pending-bytes bound and reports the loss once drained', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            const bigField = 'x'.repeat(64 * 1024);
            // 4MiB pending cap / 64KiB records: overflow the queue before any drain can run by
            // writing synchronously in a tight loop, then let the drain catch up.
            for (let index = 0; index < 80; index++)
                logger.write('info', `bulk-${index}`, { fields: { payload: bigField } });
            logger.write('info', 'dropped-tail');
            await logger.flush();

            const content = await readFile(logger.path, 'utf8');
            expect(content).not.toContain('dropped-tail');
            expect(content).toContain('log.records_dropped');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('rotates the log file before an append would overflow the size cap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            const bigField = 'y'.repeat(1024 * 1024);
            for (let index = 0; index < 6; index++) {
                logger.write('info', `rotate-${index}`, { fields: { payload: bigField } });
                // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each record must land before the next write sizes rotation.
                await logger.flush();
            }

            const rotated = await readFile(`${logger.path}.1`, 'utf8');
            const current = await readFile(logger.path, 'utf8');
            expect(rotated.length).toBeGreaterThan(0);
            expect(current).toContain('rotate-5');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
