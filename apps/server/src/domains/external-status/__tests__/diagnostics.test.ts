import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogRecord } from '@caxri/system';
import { runWithObservationContext, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { ExternalStatusCliError } from '../command';
import type { ExternalStatusCommandOptions } from '../diagnostics';
import { ExternalStatusCommandTelemetry } from '../diagnostics';

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

function observeExternalStatusCommand(
    options: ExternalStatusCommandOptions & {
        logger: StructuredLogger;
        event: 'project_status.cli' | 'session_pull_requests.cli';
    },
): Promise<string> {
    return new ExternalStatusCommandTelemetry(options.logger, options.event).observe(options);
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
            expect(logs).toHaveLength(1);
            expect(logs[0].context?.operationId).toBeDefined();
        },
    );

    it('preserves parent identity and isolates concurrent command identities', async () => {
        const logger = await createLogger();
        const failure = new ExternalStatusCliError('gh', 'network', 'PRIVATE_STDERR_SENTINEL');
        await runWithObservationContext(
            { requestId: 'request-fixture', sessionId: 'session-fixture' },
            () =>
                Promise.all(
                    [0, 1].map(() =>
                        expect(
                            observeExternalStatusCommand({
                                logger,
                                event: 'session_pull_requests.cli',
                                command: 'gh',
                                arguments: ['pr', 'list'],
                                run: () => Promise.reject(failure),
                            }),
                        ).rejects.toBe(failure),
                    ),
                ),
        );
        const logs = await records(logger);
        expect(logs).toHaveLength(2);
        const identities = new Set(logs.map((record) => record.context?.operationId));
        expect(identities.size).toBe(2);
        expect(identities.has(undefined)).toBe(false);
        for (const record of logs)
            expect(record.context).toMatchObject({
                requestId: 'request-fixture',
                sessionId: 'session-fixture',
            });
        expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
    });

    it('folds successes into one summary per operation per window', async () => {
        const logger = await createLogger();
        let now = 0;
        const telemetry = new ExternalStatusCommandTelemetry(
            logger,
            'project_status.cli',
            () => now,
            60_000,
        );
        const run = async (arguments_: readonly string[], result: Promise<string>) => {
            try {
                await telemetry.observe({
                    command: 'gh',
                    arguments: arguments_,
                    run: () => result,
                });
            } catch {
                // Failures are asserted through the log below.
            }
        };
        await run(['pr', 'list'], Promise.resolve('PRIVATE_STDOUT_SENTINEL'));
        now = 1000;
        await run(['pr', 'list'], Promise.resolve('PRIVATE_STDOUT_SENTINEL'));
        await run(
            ['pr', 'list'],
            Promise.reject(new ExternalStatusCliError('gh', 'other', 'no pull requests found')),
        );
        await run(['run', 'list'], Promise.resolve('[]'));
        expect(await records(logger)).toHaveLength(1);

        now = 60_000;
        await run(['pr', 'list'], Promise.resolve('PRIVATE_STDOUT_SENTINEL'));
        const summaries = (await records(logger)).filter(
            (record) => record.event === 'project_status.cli_summary',
        );
        expect(summaries).toHaveLength(2);
        expect(summaries[0]).toMatchObject({
            level: 'info',
            durationMs: 1000,
            fields: {
                command: 'gh',
                calls: 3,
                successes: 2,
                failures: 1,
                failureNoPullRequest: 1,
            },
        });
        expect(summaries[1].fields).toMatchObject({ calls: 1, successes: 1, failures: 0 });

        telemetry.flush();
        expect(
            (await records(logger)).filter(
                (record) => record.event === 'project_status.cli_summary',
            ),
        ).toHaveLength(3);
        expect(JSON.stringify(await records(logger))).not.toContain('PRIVATE_');
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

    it('warns once per steady prerequisite state instead of on every poll', async () => {
        const logger = await createLogger();
        const telemetry = new ExternalStatusCommandTelemetry(logger, 'session_pull_requests.cli');
        const missing = new ExternalStatusCliError('gh', 'not-found', 'gh was not found');
        const signedOut = new ExternalStatusCliError('gh', 'not-logged-in', 'run gh auth login');
        const run = (outcome: Error | string) => () =>
            typeof outcome === 'string' ? Promise.resolve(outcome) : Promise.reject(outcome);
        for (const outcome of [missing, missing, missing, signedOut, signedOut, '{}', missing]) {
            try {
                // eslint-disable-next-line no-await-in-loop -- the latch is order-dependent by design
                await telemetry.observe({
                    command: 'gh',
                    arguments: ['pr', 'view'],
                    run: run(outcome),
                });
            } catch {
                // Each failure is asserted through its log record below.
            }
        }
        const failures = (await records(logger)).filter(
            (record) => record.fields?.result === 'failure',
        );
        expect(failures.map((record) => [record.level, record.fields?.failureKind])).toEqual([
            ['warn', 'not-found'],
            ['debug', 'not-found'],
            ['debug', 'not-found'],
            ['warn', 'not-logged-in'],
            ['debug', 'not-logged-in'],
            ['warn', 'not-found'],
        ]);
    });

    it('keeps an optional command failure at debug', async () => {
        const logger = await createLogger();
        const error = new ExternalStatusCliError('git', 'other', 'not a git repository', 128);
        await expect(
            observeExternalStatusCommand({
                logger,
                event: 'project_status.cli',
                command: 'git',
                arguments: [
                    'for-each-ref',
                    '--format=%(refname) %(objectname)',
                    'refs/remotes/origin/main',
                ],
                isOptional: true,
                run: () => Promise.reject(error),
            }),
        ).rejects.toBe(error);
        expect((await records(logger)).at(-1)).toMatchObject({
            level: 'debug',
            fields: { operation: 'head.get', result: 'failure', exitCode: 128 },
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
