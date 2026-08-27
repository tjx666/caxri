import { isDeepStrictEqual } from 'node:util';

import type { ParityReceipt, PerformanceMetric } from './contracts';

const batchOrder = [
    'A0',
    'A1',
    'A2a',
    'A2b',
    'A2c',
    'A2d',
    'A2e',
    'A2f',
    'A3a',
    'A3b',
    'A4',
    'A5',
    'A6',
    'A7',
] as const;

const legacyServerTopology = {
    effectiveFromBatch: 'A3a' as const,
    metrics: {
        'open-file-descriptors': {
            absoluteCeiling: 256,
            maxRegressionRatio: 0.25,
            samples: [78, 78, 78],
            statistic: 'max',
            unit: 'count',
        },
        /**
         * The frozen A0 receipt sampled only the former Runtime PID. A3a intentionally combines the former Host and
         * Runtime owners, so comparing the new Core RSS with that partial PID would report a false regression. These
         * samples remeasure the immutable A0 artifact under the same Project/Terminal fixture and sum exactly those two
         * Server owners. Extension Host is excluded on both sides. Later split owners, including Terminal Host, must be
         * summed into the candidate value so the resource budget remains comparable across process topology changes.
         */
        'runtime-memory': {
            absoluteCeiling: 512,
            maxRegressionRatio: 0.2,
            samples: [242.42, 241.69, 242.58],
            statistic: 'p95',
            unit: 'MiB',
        },
    } satisfies Record<string, PerformanceMetric>,
    scenarioId: 'performance-budgets',
    source: {
        appVersion: '0.0.18',
        buildId: 'e6b6b5de0c018db6',
        commit: 'd370c789eb24185ee6d6d256f540a6aceedae97c',
        protocolVersion: 2,
        tree: 'f0e0725dc550c4fba1964216db471182dc684be6',
    } satisfies ParityReceipt['source'],
};

/**
 * Returns a reviewed additive baseline only when the immutable source artifact and refactor batch both match. This is
 * not an allowlist: the candidate still supplies real samples, keeps the original ratio and absolute ceilings, and
 * fails on any product-visible or unrelated metric difference.
 */
export function topologyBaselineMetric(
    source: ParityReceipt['source'],
    currentBatch: string | undefined,
    scenarioId: string,
    metricName: string,
): PerformanceMetric | undefined {
    if (!currentBatch || !isDeepStrictEqual(source, legacyServerTopology.source)) return undefined;
    const batchIndex = batchOrder.indexOf(currentBatch as (typeof batchOrder)[number]);
    const effectiveIndex = batchOrder.indexOf(legacyServerTopology.effectiveFromBatch);
    if (batchIndex < effectiveIndex || scenarioId !== legacyServerTopology.scenarioId)
        return undefined;
    return legacyServerTopology.metrics[metricName as keyof typeof legacyServerTopology.metrics];
}
