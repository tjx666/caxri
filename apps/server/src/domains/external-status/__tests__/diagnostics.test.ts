import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogRecord } from '@caxri/system';
import { runWithObservationContext, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { ExternalStatusCliError } from '../command';
import { observeExternalStatusCommand } from '../diagnostics';

const fixtures: Array<{ directory: string; logger: StructuredLogger }> = [];

afterEach(async () => {
    const pending = fixtures.slice();
    fixtures.length = 0;
    await Promise.all(
        pending.map(async (fixture) => {
            await fixture.logger.flush();
            await rm(fixture.directory, { recursive: true, force: true });
        }),
    );
});

async function createLogger() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-query-diagnostics-'));
    const logger = new StructuredLogger(directory);
    fixtures.push({ directory, logger });
    return logger;
}

async function records(logger: StructuredLogger): Promise<LogRecord[]> {
    await logger.flush();
    return (await readFile(logger.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogRecord);
}

describe('observeExternalStatusCommand', () => {
    it.each([
        ['fetch failed ECONNRESET', 'network'],
        ['certificate has expired', 'tls'],
        ['HTTP 403 forbidden', 'permission-denied'],
        ['unknown option --fixture', 'invalid-arguments'],
        ['unrecognized failure', 'other'],
    ])(
        'records a safe reason for %s without copying private diagnostics',
        async (message, reason) => {
            const logger = await createLogger();
            const error = new ExternalStatusCliError(
                'vc',
                'other',
                `${message} PRIVATE_STDERR_SENTINEL`,
                2,
            );
            await expect(
                observeExternalStatusCommand({
                    logger,
                    event: 'project_status.cli',
                    command: 'vc',
                    arguments: ['ls', 'PRIVATE_ARG_SENTINEL'],
                    run: () => Promise.reject(error),
                }),
            ).rejects.toBe(error);
            const logs = await records(logger);
            expect(logs.at(-1)).toMatchObject({
                level: 'warn',
                fields: {
                    command: 'vc',
                    operation: 'deployments.list',
                    failureKind: 'other',
                    failureReason: reason,
                    exitCode: 2,
                },
            });
            expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
            expect(logs[0].context?.operationId).toBe(logs[1].context?.operationId);
        },
    );

    it('preserves parent identity and isolates concurrent command identities', async () => {
        const logger = await createLogger();
        await runWithObservationContext(
            { requestId: 'request-fixture', sessionId: 'session-fixture' },
            () =>
                Promise.all(
                    [0, 1].map(() =>
                        observeExternalStatusCommand({
                            logger,
                            event: 'session_pull_requests.cli',
                            command: 'gh',
                            arguments: ['pr', 'list'],
                            run: () => Promise.resolve('PRIVATE_STDOUT_SENTINEL'),
                        }),
                    ),
                ),
        );
        const logs = await records(logger);
        expect(logs).toHaveLength(4);
        const identities = new Set(logs.map((record) => record.context?.operationId));
        expect(identities.size).toBe(2);
        expect(identities.has(undefined)).toBe(false);
        for (const operationId of identities) {
            expect(
                logs
                    .filter((record) => record.context?.operationId === operationId)
                    .map((record) => record.fields?.result),
            ).toEqual(['started', 'success']);
        }
        for (const record of logs)
            expect(record.context).toMatchObject({
                requestId: 'request-fixture',
                sessionId: 'session-fixture',
            });
        expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
    });

    it('keeps expected PR absence quiet and does not invent an exit code', async () => {
        const logger = await createLogger();
        const error = new ExternalStatusCliError('gh', 'other', 'no pull requests found');
        await expect(
            observeExternalStatusCommand({
                logger,
                event: 'session_pull_requests.cli',
                command: 'gh',
                arguments: ['pr', 'view'],
                run: () => Promise.reject(error),
            }),
        ).rejects.toBe(error);
        expect((await records(logger)).at(-1)).toMatchObject({
            level: 'debug',
            fields: { failureReason: 'no-pull-request', exitCode: null },
        });
    });

    it('retains timeout classification without treating arbitrary thrown values as diagnostic text', async () => {
        const logger = await createLogger();
        await Promise.all(
            [new ExternalStatusCliError('vc', 'timeout', 'private network timeout'), null].map(
                async (failure) => {
                    await expect(
                        observeExternalStatusCommand({
                            logger,
                            event: 'project_status.cli',
                            command: 'vc',
                            arguments: ['ls'],
                            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise a non-Error rejection from an external runner.
                            run: () => Promise.reject(failure),
                        }),
                    ).rejects.toBe(failure);
                },
            ),
        );
        expect(
            (await records(logger))
                .filter((record) => record.fields?.result === 'failure')
                .map((record) => record.fields?.failureReason),
        ).toEqual(['timeout', 'other']);
    });
});
