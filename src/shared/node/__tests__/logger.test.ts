import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { logEventCatalog, StructuredLogger } from '../logger';

describe('StructuredLogger', () => {
    it('rejects unregistered event names at typecheck time', () => {
        const writeUnregistered = (logger: StructuredLogger): void => {
            // @ts-expect-error -- unregistered events must fail during typecheck.
            logger.write('info', 'not.registered');
        };

        expect(writeUnregistered).toBeTypeOf('function');
    });

    it('skips verbose records below the configured production threshold', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory, 'runtime', 'info');
            logger.write('debug', logEventCatalog.git.command);
            logger.write('info', logEventCatalog.runtime.ready);
            await logger.flush();

            expect(await readFile(logger.path, 'utf8')).not.toContain(logEventCatalog.git.command);
            expect(await readFile(logger.path, 'utf8')).toContain(logEventCatalog.runtime.ready);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('recreates a deleted log directory instead of throwing into the caller', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', logEventCatalog.app.ready);
            await logger.flush();

            // Profile teardown (or uninstall tooling) can delete the log directory while a late
            // async callback still logs; that write must be best-effort, never an exception.
            await rm(directory, { recursive: true, force: true });
            expect(() => logger.write('warn', logEventCatalog.app.quitRequested)).not.toThrow();
            await logger.flush();

            expect(await readFile(logger.path, 'utf8')).toContain(
                logEventCatalog.app.quitRequested,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps write() off the disk: records land only after the async drain', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', logEventCatalog.runtime.ready);
            // Regression for issue #237: the sync logger's appendFileSync per record froze the
            // event loop whenever the disk stalled; write() must now enqueue without touching fs.
            // Checked synchronously — awaiting a read would race the async drain, which may land
            // the record before the read resolves.
            expect(existsSync(logger.path)).toBe(false);
            await logger.flush();
            expect(await readFile(logger.path, 'utf8')).toContain(logEventCatalog.runtime.ready);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('flushes error records synchronously so post-mortem evidence survives an immediate exit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', logEventCatalog.runtime.ready);
            logger.write('error', logEventCatalog.runtime.uncaughtException);

            // No flush(): both records must already be durable the instant write('error') returns.
            const content = await readFile(logger.path, 'utf8');
            expect(content).toContain(logEventCatalog.runtime.ready);
            expect(content).toContain(logEventCatalog.runtime.uncaughtException);
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
                logger.write('info', logEventCatalog.file.search, {
                    fields: { index, payload: bigField },
                });
            logger.write('info', logEventCatalog.file.searchEntrySkipped);
            await logger.flush();

            const content = await readFile(logger.path, 'utf8');
            expect(content).not.toContain(logEventCatalog.file.searchEntrySkipped);
            expect(content).toContain(logEventCatalog.log.recordsDropped);
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
                logger.write('info', logEventCatalog.file.search, {
                    fields: { index, payload: bigField },
                });
                // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each record must land before the next write sizes rotation.
                await logger.flush();
            }

            const rotated = await readFile(`${logger.path}.1`, 'utf8');
            const current = await readFile(logger.path, 'utf8');
            expect(rotated.length).toBeGreaterThan(0);
            expect(current).toContain(logEventCatalog.file.search);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
