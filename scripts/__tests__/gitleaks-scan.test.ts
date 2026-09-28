import { describe, expect, it } from 'vitest';

import { gitleaksArguments, gitleaksLogOptions } from '../gitleaks-scan';

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
