import { readdir } from 'node:fs/promises';
import process from 'node:process';

import type { StructuredLogger } from './logger.js';
import type {
    ObservationProcessManifestPublisher,
    ObservationProcessOwner,
} from './process-manifest.js';

export interface ProcessObservationSamplerOptions {
    intervalMs?: number;
    logger: StructuredLogger;
    memoryBytes?: () => number;
    openFileDescriptors?: () => Promise<number>;
    owner: ObservationProcessOwner;
    publisher: ObservationProcessManifestPublisher;
}

export interface ProcessObservationSampler {
    sample(): Promise<void>;
    stop(): void;
}

const DEFAULT_PROCESS_SAMPLE_INTERVAL_MS = 30_000;

/**
 * Samples content-free process resources at low frequency. Overlapping samples are skipped, failures are omitted, and
 * the timer is unref'd so observability never keeps a process alive or delays product work.
 */
export function startProcessObservationSampler(
    options: ProcessObservationSamplerOptions,
): ProcessObservationSampler {
    let isSampling = false;
    let isStopped = false;
    const memoryBytes = options.memoryBytes ?? (() => process.memoryUsage.rss());
    const openFileDescriptors =
        options.openFileDescriptors ?? (async () => (await readdir('/dev/fd')).length);
    const sample = async (): Promise<void> => {
        if (isSampling || isStopped) return;
        isSampling = true;
        try {
            options.logger.recordMetric('process.memory', memoryBytes(), {
                owner: options.owner,
                phase: 'runtime',
            });
            try {
                options.logger.recordMetric('process.open_fds', await openFileDescriptors(), {
                    owner: options.owner,
                    phase: 'runtime',
                });
            } catch {
                // A resource probe is optional evidence and must not affect the process or its other metrics.
            }
            options.publisher.publishMetrics(options.logger.metricSnapshot());
        } finally {
            isSampling = false;
        }
    };
    const timer = setInterval(() => {
        void sample();
    }, options.intervalMs ?? DEFAULT_PROCESS_SAMPLE_INTERVAL_MS);
    timer.unref();
    void sample();
    return {
        sample,
        stop() {
            isStopped = true;
            clearInterval(timer);
        },
    };
}
