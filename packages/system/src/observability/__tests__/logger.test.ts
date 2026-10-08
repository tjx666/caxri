import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { runWithObservationContext } from '../context';
import { logEventCatalog, MAX_LOG_BYTES, StructuredLogger } from '../logger';

// Payload that makes four records fill one generation, whatever `MAX_LOG_BYTES` currently is.
const RECORD_PAYLOAD_BYTES = MAX_LOG_BYTES / 5;

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
            const logger = new StructuredLogger(directory, 'server-core', 'info');
            logger.write('debug', logEventCatalog.git.command);
            logger.write('info', logEventCatalog.serverCore.ready);
            await logger.flush();

            expect(await readFile(logger.path, 'utf8')).not.toContain(logEventCatalog.git.command);
            expect(await readFile(logger.path, 'utf8')).toContain(logEventCatalog.serverCore.ready);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('inherits opaque async correlation and emits a content-free failure capsule', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory, 'server-core', 'info', {
                buildId: 'build-1',
                serverId: 'server-1',
            });
            logger.updateBaseContext({
                bootId: 'boot-1',
                processId: 42,
                requestId: '/private/project/source.ts',
            });
            runWithObservationContext(
                {
                    requestId: '/private/project/source.ts',
                    traceId: 'trace-1',
                },
                () => {
                    logger.write('error', logEventCatalog.serverCore.stopFailed, {
                        correlationId: 'internal-operation-1',
                        failure: {
                            code: 'SERVER_UNAVAILABLE',
                            owner: 'server-core',
                            phase: 'shutdown',
                            reason: 'core-unavailable',
                            remediation: 'restart-core',
                            retryable: true,
                        },
                    });
                },
            );

            const record = JSON.parse(await readFile(logger.path, 'utf8')) as Record<
                string,
                unknown
            >;
            expect(record.context).toEqual({
                bootId: 'boot-1',
                buildId: 'build-1',
                processId: process.pid,
                requestId: 'internal-operation-1',
                serverId: 'server-1',
                traceId: 'trace-1',
            });
            expect(record.failure).toMatchObject({
                code: 'SERVER_UNAVAILABLE',
                owner: 'server-core',
                phase: 'shutdown',
                reason: 'core-unavailable',
                remediation: 'restart-core',
            });
            expect(JSON.stringify(record)).not.toContain('/private/project/source.ts');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('exposes bounded metric aggregates without writing samples to the log', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.recordMetric('queue.wait', 2, { owner: 'control', phase: 'admission' });
            logger.recordMetric('queue.wait', 6, { owner: 'control', phase: 'admission' });

            expect(logger.metricSnapshot()).toMatchObject({
                rejectedSeries: 0,
                series: [
                    {
                        average: 4,
                        count: 2,
                        maximum: 6,
                        minimum: 2,
                        name: 'queue.wait',
                    },
                ],
            });
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
            logger.write('info', logEventCatalog.serverCore.ready);
            // Regression for issue #237: the sync logger's appendFileSync per record froze the
            // event loop whenever the disk stalled; write() must now enqueue without touching fs.
            // Checked synchronously: awaiting a read would race the async drain, which may land
            // the record before the read resolves.
            expect(existsSync(logger.path)).toBe(false);
            await logger.flush();
            expect(await readFile(logger.path, 'utf8')).toContain(logEventCatalog.serverCore.ready);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('flushes error records synchronously so post-mortem evidence survives an immediate exit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            logger.write('info', logEventCatalog.serverCore.ready);
            logger.write('error', logEventCatalog.serverCore.uncaughtException);

            // No flush(): both records must already be durable the instant write('error') returns.
            const content = await readFile(logger.path, 'utf8');
            expect(content).toContain(logEventCatalog.serverCore.ready);
            expect(content).toContain(logEventCatalog.serverCore.uncaughtException);
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
            const bigField = 'y'.repeat(RECORD_PAYLOAD_BYTES);
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

    it('opens each new generation with the volume breakdown of the rotated one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            const bigField = 'y'.repeat(RECORD_PAYLOAD_BYTES);
            for (let index = 0; index < 5; index++) {
                logger.write('info', logEventCatalog.file.search, {
                    fields: { index, payload: bigField },
                });
                logger.write('info', logEventCatalog.file.list, { fields: { index } });
                // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each record must land before the next write sizes rotation.
                await logger.flush();
            }

            const [first] = (await readFile(logger.path, 'utf8'))
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as { event: string; fields: Record<string, unknown> },
                );
            expect(first).toMatchObject({
                event: logEventCatalog.log.rotated,
                fields: {
                    countedFrom: 'processStart',
                    records: 9,
                    topEvents: `${logEventCatalog.file.search}:5,${logEventCatalog.file.list}:4`,
                    topEventShare: 56,
                },
            });
            expect(first.fields.rotatedBytes).toBeGreaterThan(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps three rotated generations and evicts the oldest beyond that window', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-logger-'));
        try {
            const logger = new StructuredLogger(directory);
            const bigField = 'y'.repeat(RECORD_PAYLOAD_BYTES);
            /**
             * Each record is a fifth of `MAX_LOG_BYTES` plus JSON overhead, so four fill a generation and 20 rotate at
             * indices 4, 8, 12, and 16: leaving four populated epochs (current, `.1`, `.2`, `.3`) and evicting the
             * oldest ([0..3]) once a fifth rotation would otherwise be needed for `.4`.
             */
            for (let index = 0; index < 20; index++) {
                logger.write('info', logEventCatalog.file.search, {
                    fields: { index, payload: bigField },
                });
                // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each record must land before the next write sizes rotation.
                await logger.flush();
            }

            const indicesIn = async (path: string): Promise<number[]> => {
                if (!existsSync(path)) return [];
                const content = await readFile(path, 'utf8');
                return content
                    .trim()
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as { event: string; fields: { index: number } })
                    .filter((record) => record.event !== logEventCatalog.log.rotated)
                    .map((record) => record.fields.index);
            };

            expect(await indicesIn(logger.path)).toEqual([16, 17, 18, 19]);
            expect(await indicesIn(`${logger.path}.1`)).toEqual([12, 13, 14, 15]);
            expect(await indicesIn(`${logger.path}.2`)).toEqual([8, 9, 10, 11]);
            expect(await indicesIn(`${logger.path}.3`)).toEqual([4, 5, 6, 7]);
            expect(existsSync(`${logger.path}.4`)).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
