import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CausalCapsule } from '../causal-chain';
import {
    MAX_PROCESS_MANIFEST_METRIC_SERIES,
    observationProcessManifestDirectory,
    observationProcessManifestPath,
    ObservationProcessManifestPublisher,
    parseObservationProcessManifest,
    readObservationProcessManifest,
} from '../process-manifest';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-observation-manifest-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('observation process manifests', () => {
    it('publishes only the latest bounded lifecycle state to private files', async () => {
        const userDataPath = await temporaryDirectory();
        const directory = observationProcessManifestDirectory(userDataPath);
        const publisher = new ObservationProcessManifestPublisher({
            context: {
                bootId: 'boot-1',
                buildId: 'build-1',
                serverId: 'server-1',
                traceId: '/private/project',
            },
            directory,
            now: () => new Date('2026-08-26T00:00:00.000Z'),
            owner: 'server-core',
            pid: 4242,
            startedAt: 1_000,
        });

        publisher.publish('starting');
        publisher.publish('ready', { context: { requestId: 'request-1' } });
        publisher.publishMetrics({
            rejectedSeries: 0,
            series: [
                {
                    average: 2,
                    count: 1,
                    labels: { owner: 'control', phase: 'admission' },
                    last: 2,
                    maximum: 2,
                    minimum: 2,
                    name: 'queue.wait',
                    total: 2,
                },
            ],
        });
        await publisher.flush();

        const path = observationProcessManifestPath(directory, 'server-core');
        await expect(readObservationProcessManifest(path)).resolves.toEqual({
            context: {
                bootId: 'boot-1',
                buildId: 'build-1',
                processId: 4242,
                requestId: 'request-1',
                serverId: 'server-1',
            },
            metrics: {
                rejectedSeries: 0,
                series: [
                    {
                        average: 2,
                        count: 1,
                        labels: { owner: 'control', phase: 'admission' },
                        last: 2,
                        maximum: 2,
                        minimum: 2,
                        name: 'queue.wait',
                        total: 2,
                    },
                ],
            },
            owner: 'server-core',
            pid: 4242,
            schemaVersion: 1,
            startedAt: 1_000,
            state: 'ready',
            updatedAt: '2026-08-26T00:00:00.000Z',
        });
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, 'utf8')).not.toContain('/private/project');
        expect(publisher.failureCount()).toBe(0);
    });

    it('rejects unknown fields and content-shaped correlation', () => {
        const base = {
            context: { processId: 42 },
            owner: 'server-core',
            pid: 42,
            schemaVersion: 1,
            startedAt: 1,
            state: 'ready',
            updatedAt: '2026-08-26T00:00:00.000Z',
        };

        expect(parseObservationProcessManifest({ ...base, credential: 'secret' })).toBeUndefined();
        expect(
            parseObservationProcessManifest({
                ...base,
                context: { processId: 42, traceId: '/private/project' },
            }),
        ).toBeUndefined();
        expect(
            parseObservationProcessManifest({
                ...base,
                metrics: {
                    rejectedSeries: 0,
                    series: [
                        {
                            average: 1,
                            count: 1,
                            labels: { owner: 'control', path: '/private/project' },
                            last: 1,
                            maximum: 1,
                            minimum: 1,
                            name: 'queue.wait',
                            total: 1,
                        },
                    ],
                },
            }),
        ).toBeUndefined();
    });

    it('bounds persisted series and rejects type-bypassed content before writing', async () => {
        const userDataPath = await temporaryDirectory();
        const directory = observationProcessManifestDirectory(userDataPath);
        const path = observationProcessManifestPath(directory, 'server-core');
        const publisher = new ObservationProcessManifestPublisher({
            directory,
            owner: 'server-core',
            pid: 42,
            startedAt: 1,
        });
        const series = Array.from({ length: MAX_PROCESS_MANIFEST_METRIC_SERIES + 6 }, () => ({
            average: 1,
            count: 1,
            labels: { owner: 'control' as const, phase: 'admission' as const },
            last: 1,
            maximum: 1,
            minimum: 1,
            name: 'queue.wait' as const,
            total: 1,
        }));
        publisher.publish('ready', { metrics: { rejectedSeries: 0, series } });
        await publisher.flush();

        expect((await readObservationProcessManifest(path)).metrics).toMatchObject({
            rejectedSeries: 6,
            series: { length: MAX_PROCESS_MANIFEST_METRIC_SERIES },
        });

        const privateSentinel = 'PRIVATE_PROMPT_TRANSCRIPT_CREDENTIAL_ENVIRONMENT_SOURCE';
        publisher.publish('failed', {
            failure: {
                schemaVersion: 1,
                timestamp: '2026-08-26T00:00:00.000Z',
                owner: 'server-core',
                phase: 'runtime',
                reason: 'unknown',
                remediation: 'inspect-artifact',
                retryable: false,
                context: { traceId: privateSentinel },
                message: privateSentinel,
            } as unknown as CausalCapsule,
            metrics: {
                rejectedSeries: 0,
                series: [
                    {
                        ...series[0],
                        labels: { owner: 'control', path: privateSentinel },
                    },
                ],
            } as never,
        });
        await publisher.flush();

        const persisted = await readObservationProcessManifest(path);
        expect(persisted.failure).toBeUndefined();
        expect(persisted.metrics).toBeUndefined();
        expect(await readFile(path, 'utf8')).not.toContain(privateSentinel);
    });

    it('rejects non-private files and keeps publication failures non-fatal', async () => {
        const userDataPath = await temporaryDirectory();
        const directory = observationProcessManifestDirectory(userDataPath);
        const path = observationProcessManifestPath(directory, 'server-core');
        const publisher = new ObservationProcessManifestPublisher({
            directory,
            owner: 'server-core',
            pid: 42,
            startedAt: 1,
        });
        publisher.publish('ready');
        await publisher.flush();
        await chmod(path, 0o644);
        await expect(readObservationProcessManifest(path)).rejects.toThrow('private regular file');

        const blockedDirectory = join(userDataPath, 'blocked');
        await writeFile(blockedDirectory, 'not a directory');
        const blocked = new ObservationProcessManifestPublisher({
            directory: join(blockedDirectory, 'processes'),
            owner: 'terminal-host',
            pid: 43,
            startedAt: 1,
        });
        blocked.publish('failed');
        await expect(blocked.flush()).resolves.toBeUndefined();
        expect(blocked.failureCount()).toBe(1);
    });
});
