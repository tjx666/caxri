import { describe, expect, it } from 'vitest';

import type { FootprintBaseline, FootprintReceipt } from '../server-footprint-gate';
import {
    compareFootprint,
    formatFootprintTable,
    updateFootprintBaseline,
} from '../server-footprint-gate';

function receipt(
    metrics: Record<string, number>,
    overrides: Partial<FootprintReceipt> = {},
): FootprintReceipt {
    return {
        buildId: 'build',
        commit: 'abc1234',
        metrics,
        runtime: 'node-v24.0.0-linux-arm64.tar.gz',
        runtimeSource: 'remote-download',
        schemaVersion: 1,
        target: 'linux-arm64',
        timings: {},
        version: '0.0.1',
        ...overrides,
    };
}

const baseline: FootprintBaseline = {
    schemaVersion: 1,
    tolerances: {
        disk: { absoluteKiB: 0, relative: 0.1 },
        memory: { absoluteKiB: 1000, relative: 0 },
    },
    targets: {
        'linux-arm64': {
            commit: 'old',
            metrics: { 'disk.totalKiB': 10_000, 'memory.attached.totalPssKiB': 50_000 },
            recordedAt: '2026-01-01T00:00:00.000Z',
            runtime: 'node-v24.0.0-linux-arm64.tar.gz',
            runtimeSource: 'remote-download',
        },
    },
};

describe('compareFootprint', () => {
    it('passes within the tolerance and fails above it', () => {
        const within = compareFootprint(
            receipt({ 'disk.totalKiB': 11_000, 'memory.attached.totalPssKiB': 51_000 }),
            baseline,
        );
        expect(within.isFailed).toBe(false);
        expect(within.rows.map((row) => row.verdict)).toEqual(['pass', 'pass']);

        const above = compareFootprint(
            receipt({ 'disk.totalKiB': 11_001, 'memory.attached.totalPssKiB': 51_000 }),
            baseline,
        );
        expect(above.isFailed).toBe(true);
        expect(above.rows[0]).toMatchObject({ limit: 11_000, verdict: 'regressed' });
    });

    it('reports an improvement beyond the tolerance without failing', () => {
        const comparison = compareFootprint(
            receipt({ 'disk.totalKiB': 8999, 'memory.attached.totalPssKiB': 50_000 }),
            baseline,
        );
        expect(comparison.isFailed).toBe(false);
        expect(comparison.rows[0]?.verdict).toBe('improved');
    });

    it('fails on a missing metric and lists a new one', () => {
        const comparison = compareFootprint(
            receipt({ 'disk.totalKiB': 10_000, 'memory.working.totalPssKiB': 60_000 }),
            baseline,
        );
        expect(comparison.isFailed).toBe(true);
        expect(comparison.rows.map((row) => [row.metric, row.verdict])).toEqual([
            ['disk.totalKiB', 'pass'],
            ['memory.attached.totalPssKiB', 'missing'],
            ['memory.working.totalPssKiB', 'new'],
        ]);
    });

    it('refuses an unknown target or a different runtime source', () => {
        const unknown = compareFootprint(receipt({}, { target: 'linux-x64' }), baseline);
        expect(unknown.isFailed).toBe(true);
        expect(unknown.blocker).toContain('No baseline for linux-x64');
        const uploaded = compareFootprint(receipt({}, { runtimeSource: 'local-upload' }), baseline);
        expect(uploaded.isFailed).toBe(true);
        expect(formatFootprintTable(uploaded)).toContain('local-upload');
    });
});

describe('updateFootprintBaseline', () => {
    it('replaces only the receipt target and keeps the tolerances', () => {
        const withOther: FootprintBaseline = {
            ...baseline,
            targets: { ...baseline.targets, 'linux-x64': baseline.targets['linux-arm64'] },
        };
        const updated = updateFootprintBaseline(
            withOther,
            receipt({ 'disk.totalKiB': 9000 }),
            '2026-02-01T00:00:00.000Z',
        );
        expect(updated.tolerances).toBe(baseline.tolerances);
        expect(updated.targets['linux-x64']).toBe(baseline.targets['linux-arm64']);
        expect(updated.targets['linux-arm64']).toEqual({
            commit: 'abc1234',
            metrics: { 'disk.totalKiB': 9000 },
            recordedAt: '2026-02-01T00:00:00.000Z',
            runtime: 'node-v24.0.0-linux-arm64.tar.gz',
            runtimeSource: 'remote-download',
        });
    });
});
