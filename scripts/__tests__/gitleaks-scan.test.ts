import { resolve } from 'node:path';
import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { execFileAsync } from '../exec';
import {
    gitleaksArguments,
    gitleaksLogOptions,
    isGitleaksRevisionRangeValid,
    runGitleaksScan,
    unsupportedGitleaksArguments,
} from '../gitleaks-scan';

const projectRoot = resolve(import.meta.dirname, '../..');
async function runGitleaksEntrypoint(baseRevision: string, headRevision = 'HEAD') {
    const { stdout: bunPath } = await execFileAsync('which', ['bun']);
    return execFileAsync(bunPath.trim(), ['run', 'scripts/gitleaks-scan.ts'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            GITLEAKS_BASE_REVISION: baseRevision,
            GITLEAKS_HEAD_REVISION: headRevision,
            PATH: '/usr/bin:/bin',
        },
    });
}

function isExecFileFailure(value: unknown): value is { code: number; stderr: string } {
    if (typeof value !== 'object' || value === null) return false;
    const failure = value as { code?: unknown; stderr?: unknown };
    return typeof failure.code === 'number' && typeof failure.stderr === 'string';
}

describe('gitleaksLogOptions', () => {
    const head = '1111111111111111111111111111111111111111';

    it('scans only the introduced commits when a real base revision is given', () => {
        const base = '2222222222222222222222222222222222222222';
        expect(gitleaksLogOptions(base, head)).toBe(`${base}..${head}`);
    });

    it('falls back to full history when no base revision is given', () => {
        expect(gitleaksLogOptions(undefined, head)).toBeUndefined();
        expect(gitleaksLogOptions('', head)).toBeUndefined();
        expect(gitleaksLogOptions(' '.repeat(3), head)).toBeUndefined();
    });

    it('falls back to full history for the all-zero sentinel of a branch-creating push', () => {
        expect(gitleaksLogOptions('0'.repeat(40), head)).toBeUndefined();
    });

    it('falls back to full history when the base equals the head (no new commits)', () => {
        expect(gitleaksLogOptions(head, head)).toBeUndefined();
    });
});

describe('unsupportedGitleaksArguments', () => {
    it('accepts a staged scan and rejects revisions passed as arguments', () => {
        expect(unsupportedGitleaksArguments(['--staged'])).toEqual([]);
        expect(unsupportedGitleaksArguments(['--', '--staged'])).toEqual([]);
        expect(unsupportedGitleaksArguments(['origin/main', 'HEAD'])).toEqual([
            'origin/main',
            'HEAD',
        ]);
    });
});

describe('gitleaksArguments', () => {
    const repoRoot = '/repo';
    const configPath = '/repo/.gitleaks.toml';

    it('builds a staged scan for the pre-commit hook', () => {
        expect(gitleaksArguments({ configPath, repoRoot, staged: true })).toEqual([
            'git',
            repoRoot,
            '--config',
            configPath,
            '--redact',
            '--exit-code',
            '1',
            '--staged',
        ]);
    });

    it('builds a full-history scan when no log-opts range is given', () => {
        expect(gitleaksArguments({ configPath, repoRoot, staged: false })).toEqual([
            'git',
            repoRoot,
            '--config',
            configPath,
            '--redact',
            '--exit-code',
            '1',
        ]);
    });

    it('builds a commit-range scan when a log-opts range is given', () => {
        expect(
            gitleaksArguments({ configPath, logOptions: 'base..head', repoRoot, staged: false }),
        ).toEqual([
            'git',
            repoRoot,
            '--config',
            configPath,
            '--redact',
            '--exit-code',
            '1',
            '--log-opts=base..head',
        ]);
    });
});

describe('isGitleaksRevisionRangeValid', () => {
    it('skips Git validation when the scan has no explicit range', async () => {
        const run = vi.fn();

        await expect(isGitleaksRevisionRangeValid('/repo', undefined, run)).resolves.toBe(true);
        expect(run).not.toHaveBeenCalled();
    });

    it('asks Git to resolve the exact range before gitleaks runs', async () => {
        const run = vi.fn().mockResolvedValue(0);

        await expect(isGitleaksRevisionRangeValid('/repo', 'base..head', run)).resolves.toBe(true);
        expect(run).toHaveBeenCalledWith('git', ['rev-list', '--max-count=0', 'base..head', '--'], {
            cwd: '/repo',
            stdio: 'ignore',
        });
    });

    it.each(['missing..head', 'base..missing'])(
        'fails closed when Git cannot resolve %s',
        async (range) => {
            const run = vi.fn().mockResolvedValue(128);

            await expect(isGitleaksRevisionRangeValid('/repo', range, run)).resolves.toBe(false);
        },
    );
});

describe('runGitleaksScan', () => {
    const options = {
        baseRevision: 'base',
        cacheRoot: '/cache',
        headRevision: 'head',
        repoRoot: '/repo',
        staged: false,
    };

    it('fails before launching gitleaks when the configured range is invalid', async () => {
        const resolveBinary = vi.fn();
        const run = vi.fn().mockResolvedValue(128);

        await expect(runGitleaksScan(options, { resolveBinary, run })).resolves.toEqual({
            exitCode: 1,
            status: 'invalid-revision-range',
        });
        expect(resolveBinary).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledOnce();
    });

    it.each([undefined, '', '0'.repeat(40), 'head'])(
        'keeps the full-history fallback for base revision %j',
        async (baseRevision) => {
            const resolveBinary = vi.fn().mockResolvedValue('/fake/gitleaks');
            const run = vi.fn().mockResolvedValue(0);

            await expect(
                runGitleaksScan({ ...options, baseRevision }, { resolveBinary, run }),
            ).resolves.toEqual({ exitCode: 0, status: 'passed' });
            expect(resolveBinary).toHaveBeenCalledOnce();
            expect(run).toHaveBeenCalledOnce();
            expect(run.mock.calls[0]?.[1]).not.toContain('--log-opts=base..head');
        },
    );

    it('passes a resolvable range to gitleaks unchanged', async () => {
        const resolveBinary = vi.fn().mockResolvedValue('/fake/gitleaks');
        const run = vi.fn().mockResolvedValue(0);

        await expect(runGitleaksScan(options, { resolveBinary, run })).resolves.toEqual({
            exitCode: 0,
            status: 'passed',
        });
        expect(run).toHaveBeenNthCalledWith(
            2,
            '/fake/gitleaks',
            expect.arrayContaining(['--log-opts=base..head']),
            { cwd: '/repo', stdio: 'inherit' },
        );
    });

    it('exits nonzero at the real entrypoint for an invalid range', async () => {
        try {
            await runGitleaksEntrypoint('missing-revision');
            expect.fail('Expected the gitleaks entrypoint to fail');
        } catch (error) {
            expect(isExecFileFailure(error)).toBe(true);
            if (!isExecFileFailure(error)) return;
            expect(error.code).toBe(1);
            expect(error.stderr).toContain('revision range cannot be resolved');
        }
    });
});
