import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isProtectedRetryPath } from '../ci-path-policy';
import { measureSizeReport, parseSizeReport, SIZE_REPORT_COMPONENTS } from '../ci-size-report';

const SHA = 'a'.repeat(40);
const roots: string[] = [];

afterEach(async () => {
    const pending = [...roots];
    roots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { force: true, recursive: true })));
});

async function writeSized(path: string, bytes: number): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x'.repeat(bytes));
}

describe('ci-size-report', () => {
    it('measures shipped bytes and Source Maps separately without following directory symlinks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-size-report-'));
        roots.push(root);
        await writeSized(join(root, '_expo/static/js/android/entry.hbc'), 300);
        await writeSized(join(root, '_expo/static/js/android/entry.hbc.map'), 50);
        await writeSized(join(root, 'assets/logo'), 20);
        await symlink(join(root, 'assets'), join(root, '_expo/static/js/android/linked'));

        const report = await measureSizeReport('mobile', root, SHA);

        expect(report).toEqual({
            schema: 1,
            kind: 'mobile',
            sha: SHA,
            components: {
                'Android JS bundle (Hermes bytecode)': { bytes: 300, sourceMapBytes: 50 },
                'Bundled assets': { bytes: 20, sourceMapBytes: 0 },
            },
        });
    });

    it('fails when a tracked output is missing instead of reporting zero', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-size-report-'));
        roots.push(root);
        await expect(measureSizeReport('mobile', root, SHA)).rejects.toThrow(/ENOENT/u);
    });

    it('keeps only allowlisted labels from an untrusted report', () => {
        const report = parseSizeReport(
            JSON.stringify({
                schema: 1,
                kind: 'desktop',
                sha: SHA,
                components: {
                    'out/main': { bytes: 10, sourceMapBytes: 5 },
                    '<img src=x onerror=alert(1)>': { bytes: 1, sourceMapBytes: 0 },
                },
            }),
            'desktop',
        );
        expect(report.components).toEqual({ 'out/main': { bytes: 10, sourceMapBytes: 5 } });
    });

    it.each([
        ['a wrong schema', { schema: 2, kind: 'desktop', sha: SHA, components: {} }],
        ['a different kind', { schema: 1, kind: 'mobile', sha: SHA, components: {} }],
        ['a short SHA', { schema: 1, kind: 'desktop', sha: 'abc', components: {} }],
        [
            'a non-integer size',
            {
                schema: 1,
                kind: 'desktop',
                sha: SHA,
                components: { 'out/main': { bytes: '10', sourceMapBytes: 0 } },
            },
        ],
        [
            'a negative size',
            {
                schema: 1,
                kind: 'desktop',
                sha: SHA,
                components: { 'out/main': { bytes: -1, sourceMapBytes: 0 } },
            },
        ],
    ])('rejects %s', (_name, value) => {
        expect(() => parseSizeReport(JSON.stringify(value), 'desktop')).toThrow();
    });

    it('rejects an oversized report before parsing it', () => {
        expect(() => parseSizeReport(' '.repeat(65 * 1_024), 'desktop')).toThrow(/64 KiB/u);
    });

    it('measures desktop rows that build on any platform and carry their budgets', () => {
        const desktop = SIZE_REPORT_COMPONENTS.desktop;
        expect(desktop.every(({ path }) => !path.startsWith('release.noindex/'))).toBe(true);
        expect(desktop.find(({ label }) => label === 'out/renderer')?.budgetBytes).toBe(
            46 * 1_024 * 1_024,
        );
        expect(
            SIZE_REPORT_COMPONENTS.packaged.every(({ path }) =>
                path.startsWith('release.noindex/'),
            ),
        ).toBe(true);
    });

    it('routes changes to the report scripts through full validation', () => {
        expect(isProtectedRetryPath('scripts/ci-size-report.ts')).toBe(true);
        expect(isProtectedRetryPath('scripts/ci-size-comment.ts')).toBe(true);
    });
});
