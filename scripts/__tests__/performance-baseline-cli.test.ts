import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArguments as parseCollectArguments } from '../performance-baseline-collect';
import {
    isSamplesReceipt,
    parseArguments as parseDeriveArguments,
} from '../performance-baseline-derive';
import {
    parseArguments as parseGateArguments,
    shouldSkipForChangedFiles,
} from '../performance-baseline-gate';

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
