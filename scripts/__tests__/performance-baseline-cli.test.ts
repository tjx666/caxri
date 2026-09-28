import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArguments as parseCollectArguments } from '../performance-baseline-collect';
import {
    isSamplesReceipt,
    parseArguments as parseDeriveArguments,
    resolveInputPaths,
} from '../performance-baseline-derive';
import {
    parseArguments as parseGateArguments,
    shouldSkipForChangedFiles,
} from '../performance-baseline-gate';
import { parseArguments as parseTrendArguments } from '../performance-trend-check';

describe('performance-baseline-collect parseArguments', () => {
    it('applies defaults and accumulates repeated --env flags', () => {
        const options = parseCollectArguments([
            '--spec',
            'e2e/renderer.performance.e2e.ts',
            '--env',
            'CAXRI_RENDERER_BENCHMARK=1',
            '--env',
            'CAXRI_E2E_OUTPUT_DIR=test-results/renderer-performance',
        ]);
        expect(options.spec).toBe('e2e/renderer.performance.e2e.ts');
        expect(options.iterations).toBe(10);
        expect(options.env).toEqual({
            CAXRI_RENDERER_BENCHMARK: '1',
            CAXRI_E2E_OUTPUT_DIR: 'test-results/renderer-performance',
        });
    });

    it('requires --spec', () => {
        expect(() => parseCollectArguments(['--iterations', '5'])).toThrow(/--spec/u);
    });

    it('rejects a non-positive iteration count', () => {
        expect(() =>
            parseCollectArguments([
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--iterations',
                '0',
            ]),
        ).toThrow(/--iterations/u);
    });
});

describe('performance-baseline-derive parseArguments', () => {
    it('requires at least one --input and a --spec', () => {
        expect(() => parseDeriveArguments(['--spec', 'e2e/renderer.performance.e2e.ts'])).toThrow(
            /--input/u,
        );
        expect(() => parseDeriveArguments(['--input', 'a.json'])).toThrow(/--spec/u);
    });

    it('defaults to a local, unarmed source', () => {
        const options = parseDeriveArguments([
            '--input',
            'a.json',
            '--spec',
            'e2e/renderer.performance.e2e.ts',
        ]);
        expect(options.source).toBe('local');
    });

    it('rejects an unknown --source value', () => {
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--source',
                'staging',
            ]),
        ).toThrow(/--source/u);
    });

    it('splits --metrics into a trimmed list', () => {
        const options = parseDeriveArguments([
            '--input',
            'a.json',
            '--spec',
            'e2e/renderer.performance.e2e.ts',
            '--metrics',
            'durationMs, react.commitCount',
        ]);
        expect(options.metrics).toEqual(['durationMs', 'react.commitCount']);
    });

    it('accumulates repeated --input-dir flags and accepts --input-dir instead of --input', () => {
        const options = parseDeriveArguments([
            '--input-dir',
            'dir-a',
            '--input-dir',
            'dir-b',
            '--spec',
            'e2e/renderer.performance.e2e.ts',
        ]);
        expect(options.inputDirs).toEqual(['dir-a', 'dir-b']);
        expect(options.inputs).toEqual([]);
    });

    it('requires --provenance for --source runner but not for --source local', () => {
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--source',
                'runner',
            ]),
        ).toThrow(/--provenance/u);
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--source',
                'runner',
                '--provenance',
                'runs 1-100, 2026-01-01 to 2026-01-02',
            ]),
        ).not.toThrow();
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
            ]),
        ).not.toThrow();
    });

    it('rejects a negative --relative-margin or --absolute-margin-ms', () => {
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--relative-margin',
                '-1',
            ]),
        ).toThrow(/--relative-margin/u);
        expect(() =>
            parseDeriveArguments([
                '--input',
                'a.json',
                '--spec',
                'e2e/renderer.performance.e2e.ts',
                '--absolute-margin-ms',
                '-1',
            ]),
        ).toThrow(/--absolute-margin-ms/u);
    });
});

describe('performance-baseline-derive resolveInputPaths', () => {
    let root: string;

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('combines explicit --input paths with every renderer-performance.json found under --input-dir', async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-performance-derive-'));
        await mkdir(join(root, 'run-1'), { recursive: true });
        await mkdir(join(root, 'run-2'), { recursive: true });
        await writeFile(join(root, 'run-1', 'renderer-performance.json'), '{}', 'utf8');
        await writeFile(join(root, 'run-2', 'renderer-performance.json'), '{}', 'utf8');

        const options = parseDeriveArguments([
            '--input',
            'explicit.json',
            '--input-dir',
            root,
            '--spec',
            'e2e/renderer.performance.e2e.ts',
        ]);
        const resolved = (await resolveInputPaths(options)).toSorted((left, right) =>
            left.localeCompare(right),
        );
        expect(resolved).toEqual(
            [
                'explicit.json',
                join(root, 'run-1', 'renderer-performance.json'),
                join(root, 'run-2', 'renderer-performance.json'),
            ].toSorted((left, right) => left.localeCompare(right)),
        );
    });

    it('throws when --input-dir finds nothing rather than silently deriving from zero receipts', async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-performance-derive-empty-'));
        const options = parseDeriveArguments([
            '--input-dir',
            root,
            '--spec',
            'e2e/renderer.performance.e2e.ts',
        ]);
        await expect(resolveInputPaths(options)).rejects.toThrow(
            /found no renderer-performance\.json/u,
        );
    });
});

describe('performance-trend-check parseArguments', () => {
    it('requires --receipts-dir', () => {
        expect(() => parseTrendArguments([])).toThrow(/--receipts-dir/u);
    });

    it('applies the documented defaults', () => {
        const options = parseTrendArguments(['--receipts-dir', 'dir']);
        expect(options.baseline).toBe('scripts/performance-baseline.json');
        expect(options.windowSize).toBe(20);
        expect(options.alarmRatio).toBe(0.02);
    });

    it('rejects a non-positive --window or --alarm-ratio', () => {
        expect(() => parseTrendArguments(['--receipts-dir', 'dir', '--window', '0'])).toThrow(
            /--window/u,
        );
        expect(() => parseTrendArguments(['--receipts-dir', 'dir', '--alarm-ratio', '0'])).toThrow(
            /--alarm-ratio/u,
        );
    });

    it('overrides --baseline, --window, and --alarm-ratio', () => {
        const options = parseTrendArguments([
            '--receipts-dir',
            'dir',
            '--baseline',
            'custom-baseline.json',
            '--window',
            '30',
            '--alarm-ratio',
            '0.03',
        ]);
        expect(options.baseline).toBe('custom-baseline.json');
        expect(options.windowSize).toBe(30);
        expect(options.alarmRatio).toBe(0.03);
    });
});

describe('isSamplesReceipt', () => {
    it('recognizes a collected samples receipt by its top-level samples object', () => {
        expect(isSamplesReceipt({ samples: { durationMs: [1, 2, 3] } })).toBe(true);
    });

    it('rejects a single-run benchmark receipt with no samples field', () => {
        expect(isSamplesReceipt({ durationMs: 120 })).toBe(false);
        expect(isSamplesReceipt(null)).toBe(false);
        expect(isSamplesReceipt(42)).toBe(false);
    });
});

describe('performance-baseline-gate parseArguments', () => {
    it('requires --baseline and exactly one of --receipt or --samples', () => {
        expect(() => parseGateArguments(['--receipt', 'a.json'])).toThrow(/--baseline/u);
        expect(() => parseGateArguments(['--baseline', 'b.json'])).toThrow(
            /One of --receipt or --samples/u,
        );
        expect(() =>
            parseGateArguments([
                '--baseline',
                'b.json',
                '--receipt',
                'a.json',
                '--samples',
                's.json',
            ]),
        ).toThrow(/mutually exclusive/u);
    });

    it('resolves to a discriminated receipt or samples mode', () => {
        expect(parseGateArguments(['--baseline', 'b.json', '--receipt', 'a.json'])).toEqual({
            baseline: 'b.json',
            current: 'a.json',
            mode: 'receipt',
        });
        expect(parseGateArguments(['--baseline', 'b.json', '--samples', 's.json'])).toEqual({
            baseline: 'b.json',
            current: 's.json',
            mode: 'samples',
        });
    });
});

describe('shouldSkipForChangedFiles', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('never skips outside CI, regardless of the changed-files signal', () => {
        vi.stubEnv('GITHUB_ACTIONS', undefined);
        vi.stubEnv('CI_CHANGED_FILES', JSON.stringify(['docs/README.md']));
        expect(shouldSkipForChangedFiles()).toBe(false);
    });

    it('skips in CI when every changed file is irrelevant to performance', () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true');
        vi.stubEnv('CI_CHANGED_FILES', JSON.stringify(['docs/README.md', 'apps/cli/src/bin.ts']));
        expect(shouldSkipForChangedFiles()).toBe(true);
    });

    it('runs in CI when at least one changed file is performance-relevant', () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true');
        vi.stubEnv(
            'CI_CHANGED_FILES',
            JSON.stringify(['docs/README.md', 'apps/desktop/src/renderer/src/app.tsx']),
        );
        expect(shouldSkipForChangedFiles()).toBe(false);
    });

    it('defaults to running when there is no changed-files signal at all', () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true');
        vi.stubEnv('CI_CHANGED_FILES', undefined);
        expect(shouldSkipForChangedFiles()).toBe(false);
    });

    it('fails closed to running when the changed-files signal is malformed', () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true');
        vi.stubEnv('CI_CHANGED_FILES', 'not json');
        expect(shouldSkipForChangedFiles()).toBe(false);
    });

    it('defaults to running when the changed-files list is empty', () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true');
        vi.stubEnv('CI_CHANGED_FILES', JSON.stringify([]));
        expect(shouldSkipForChangedFiles()).toBe(false);
    });
});
