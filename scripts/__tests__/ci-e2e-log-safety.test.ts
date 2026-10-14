import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { execFileAsync } from '../exec';

const root = new URL('../../', import.meta.url);
const repoRoot = fileURLToPath(root);
const ciSource = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
const releaseSource = await readFile(new URL('.github/workflows/release.yml', root), 'utf8');

interface ExecutableSource {
    path: string;
    source: string;
}

const executableSourcePattern =
    /(?:^|\/)(?:[^/]+\.(?:cjs|js|json|mjs|sh|toml|ts|tsx|yaml|yml)|Dockerfile)$/u;
const playwrightCommandPattern = /\bplaywright\s+test\b|['"`]playwright['"`]\s*,\s*['"`]test['"`]/u;
const alternateConfigPattern = /--config|(?:^|[\s'"`])-c(?:$|[\s'"`,=])/mu;

function isTestSource(path: string): boolean {
    return path.includes('/__tests__/') || /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/u.test(path);
}

async function executableSources(): Promise<ExecutableSource[]> {
    const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: repoRoot },
    );
    const paths = stdout
        .split('\0')
        .filter((path) => path && executableSourcePattern.test(path) && !isTestSource(path));
    const sources = await Promise.all(
        paths.map(async (path) => {
            try {
                return { path, source: await readFile(join(repoRoot, path), 'utf8') };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
        }),
    );
    return sources.filter((source) => source !== undefined);
}

function valuesForKey(value: unknown, key: string): unknown[] {
    if (Array.isArray(value)) return value.flatMap((item) => valuesForKey(item, key));
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([entryKey, entryValue]) => [
        ...(entryKey === key ? [entryValue] : []),
        ...valuesForKey(entryValue, key),
    ]);
}

function reporterEnvironmentLines(source: string): string[] {
    return source
        .matchAll(/^.*PW_TEST_REPORTER.*$/gmu)
        .map(([line]) => line.trim())
        .toArray();
}

describe('public Actions E2E log boundary', () => {
    it('routes every Actions E2E surface through the content-safe reporter', async () => {
        const ci = parse(ciSource) as {
            jobs: Record<string, { env?: Record<string, string>; steps?: Array<{ run?: string }> }>;
        };
        const release = parse(releaseSource) as {
            jobs: Record<string, { env?: Record<string, string>; steps?: Array<{ run?: string }> }>;
        };
        expect(ci.jobs['hosted-smoke'].env?.PW_TEST_REPORTER).toBe('');
        expect(ci.jobs.e2e.env?.PW_TEST_REPORTER).toBe('');
        expect(release.jobs.rehearsal.env?.PW_TEST_REPORTER).toBe('');
        expect(release.jobs.release.env?.PW_TEST_REPORTER).toBe('');
        expect(valuesForKey(ci, 'PW_TEST_REPORTER')).toEqual(['', '']);
        expect(valuesForKey(release, 'PW_TEST_REPORTER')).toEqual(['', '']);
        expect(reporterEnvironmentLines(ciSource)).toEqual([
            "PW_TEST_REPORTER: ''",
            "PW_TEST_REPORTER: ''",
        ]);
        expect(reporterEnvironmentLines(releaseSource)).toEqual([
            "PW_TEST_REPORTER: ''",
            "PW_TEST_REPORTER: ''",
        ]);

        const releaseReporter =
            './scripts/reporters/public-e2e-reporter.ts,./scripts/reporters/e2e-receipt-reporter.ts';
        const releaseReporterArguments = releaseSource
            .matchAll(/--reporter=(\S+)/gu)
            .map((match) => match[1])
            .toArray();
        expect(releaseReporterArguments).toEqual([releaseReporter, releaseReporter]);

        const config = await readFile(new URL('playwright.config.ts', root), 'utf8');
        expect(config).toContain('shouldUsePublicE2EReporter(process.env)');
        expect(config).toContain("publicE2EReporterPath : 'list'");

        const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
            scripts: Record<string, string>;
        };
        expect(manifest.scripts['test:smoke']).toContain('check e2e/smoke.e2e.ts --e2e');
        const playwrightScripts = Object.entries(manifest.scripts).filter(([, command]) =>
            command.includes('playwright test'),
        );
        expect(playwrightScripts.length).toBeGreaterThan(0);
        for (const [, command] of playwrightScripts) {
            expect(command).not.toContain('--reporter');
            expect(command).not.toContain('--add-reporter');
            expect(command).not.toContain('PW_TEST_REPORTER');
            expect(command).not.toMatch(alternateConfigPattern);
        }

        const directWorkflowRuns = [ci, release].flatMap(({ jobs }) =>
            Object.values(jobs).flatMap(({ steps = [] }) =>
                steps.flatMap(({ run }) =>
                    run && playwrightCommandPattern.test(run) ? [run] : [],
                ),
            ),
        );
        expect(directWorkflowRuns).toHaveLength(2);
        for (const run of directWorkflowRuns) expect(run).not.toMatch(alternateConfigPattern);
    });

    it('allows no non-public reporter override in any executable repository source', async () => {
        const sources = await executableSources();
        const reporterOwners = sources
            .filter(({ source }) => source.includes('--reporter'))
            .map(({ path }) => path)
            .toSorted((left, right) => left.localeCompare(right));
        expect(reporterOwners).toEqual([
            '.agents/skills/quality-check/scripts/full-suite-authorization.ts',
            '.github/workflows/release.yml',
            'scripts/reporters/public-e2e-reporter.ts',
        ]);
        const additiveReporterOwners = sources
            .filter(({ source }) => source.includes('--add-reporter'))
            .map(({ path }) => path);
        expect(additiveReporterOwners).toEqual([
            '.agents/skills/quality-check/scripts/full-suite-authorization.ts',
        ]);
        const reporterEnvironmentOwners = sources
            .filter(({ source }) => source.includes('PW_TEST_REPORTER'))
            .map(({ path }) => path)
            .toSorted((left, right) => left.localeCompare(right));
        expect(reporterEnvironmentOwners).toEqual([
            '.github/workflows/ci.yml',
            '.github/workflows/release.yml',
        ]);

        const authorization = sources.find(
            ({ path }) =>
                path === '.agents/skills/quality-check/scripts/full-suite-authorization.ts',
        );
        expect(authorization?.source).not.toContain('--reporter=');
        expect(authorization?.source.match(/['"]--reporter['"]/gu)).toHaveLength(2);
        expect(authorization?.source).not.toContain('--add-reporter=');
        expect(authorization?.source.match(/['"]--add-reporter['"]/gu)).toHaveLength(1);

        const alternateConfigOwners = sources.filter(
            ({ source }) =>
                playwrightCommandPattern.test(source) && alternateConfigPattern.test(source),
        );
        expect(
            alternateConfigOwners
                .map(({ path }) => path)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([
            '.agents/skills/quality-check/scripts/full-suite-authorization.ts',
            '.github/workflows/release.yml',
            'package.json',
            'scripts/run-e2e-census-fixture.ts',
        ]);
        for (const { path, source } of alternateConfigOwners) {
            if (path === 'scripts/run-e2e-census-fixture.ts') {
                expect(source).toContain('playwrightReporterArgument');
            } else {
                expect(source).not.toMatch(/(?:exec|spawn|runChildProcess)\s*\(/u);
            }
        }
    });
});
