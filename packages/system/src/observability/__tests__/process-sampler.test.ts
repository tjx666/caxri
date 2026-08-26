import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../logger';
import {
    observationProcessManifestPath,
    ObservationProcessManifestPublisher,
    readObservationProcessManifest,
} from '../process-manifest';
import { startProcessObservationSampler } from '../process-sampler';

describe('process observation sampler', () => {
    it('persists bounded memory and file-descriptor aggregates without blocking startup', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-process-sampler-'));
        try {
            const logger = new StructuredLogger(join(directory, 'logs'));
            const publisher = new ObservationProcessManifestPublisher({
                directory,
                owner: 'server-core',
                pid: 42,
                startedAt: 1,
            });
            publisher.publish('ready');
            const sampler = startProcessObservationSampler({
                intervalMs: 60_000,
                logger,
                memoryBytes: () => 1_024,
                openFileDescriptors: () => Promise.resolve(12),
                owner: 'server-core',
                publisher,
            });

            await vi.waitFor(() => expect(logger.metricSnapshot().series).toHaveLength(2));
            sampler.stop();
            await publisher.flush();
            const manifest = await readObservationProcessManifest(
                observationProcessManifestPath(directory, 'server-core'),
            );
            expect(manifest.metrics?.series.map(({ name, last }) => ({ name, last }))).toEqual([
                { name: 'process.memory', last: 1_024 },
                { name: 'process.open_fds', last: 12 },
            ]);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
