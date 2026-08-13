import { describe, expect, it } from 'vitest';

import {
    directImportTestCandidates,
    lintPipelineForFile,
    parseCheckArgs,
    playwrightArguments,
    selectE2ESpecs,
    selectedTestCandidates,
    testCandidatesForFile,
    testDirectlyImportsSource,
} from './check';

describe('parseCheckArgs', () => {
    it('defaults to lint and related tests', () => {
        expect(parseCheckArgs(['src/main/index.ts'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: ['src/main/index.ts'],
            knip: false,
            lint: true,
            staged: false,
            test: true,
            type: false,
        });
    });

    it('uses explicit selectors without adding defaults', () => {
        expect(parseCheckArgs(['--staged', '--type'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: [],
            knip: false,
            lint: false,
            staged: true,
            test: false,
            type: true,
        });
    });

    it('treats --knip as an explicit selector that suppresses defaults', () => {
        expect(parseCheckArgs(['--knip'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: [],
            knip: true,
            lint: false,
            staged: false,
            test: false,
            type: false,
        });
    });

    it('selects focused Playwright coverage without adding default checks', () => {
        expect(
            parseCheckArgs(['e2e/smoke.e2e.ts', '--e2e', '--e2e-grep', 'launches the workbench']),
        ).toEqual({
            e2e: true,
            e2eGrep: 'launches the workbench',
            files: ['e2e/smoke.e2e.ts'],
            knip: false,
            lint: false,
            staged: false,
            test: false,
            type: false,
        });
    });

    it('rejects an e2e grep without the e2e selector', () => {
        expect(() => parseCheckArgs(['--e2e-grep', 'launches'])).toThrow(
            '--e2e-grep requires --e2e',
        );
    });
});

describe('selectE2ESpecs', () => {
    it('keeps only explicit Playwright specs', () => {
        expect(
            selectE2ESpecs(['src/main/index.ts', 'e2e/smoke.e2e.ts', 'e2e/settings.e2e.ts'], true),
        ).toEqual(['e2e/smoke.e2e.ts', 'e2e/settings.e2e.ts']);
    });

    it('fails closed without explicit file arguments', () => {
        expect(() => selectE2ESpecs(['e2e/smoke.e2e.ts'], false)).toThrow(
            '--e2e requires an explicit e2e/*.e2e.ts file',
        );
    });

    it('fails closed when explicit files contain no Playwright spec', () => {
        expect(() => selectE2ESpecs(['src/main/index.ts'], true)).toThrow(
            '--e2e requires an explicit e2e/*.e2e.ts file',
        );
    });

    it('keeps the authenticated real-Agent smoke behind its manual entrypoint', () => {
        expect(() => selectE2ESpecs(['e2e/real-agent-smoke.e2e.ts'], true)).toThrow(
            'Use bun run test:e2e:real-agent for the manual real-Agent smoke',
        );
    });

    it('keeps intentional failure isolation behind its validating wrapper', () => {
        expect(() => selectE2ESpecs(['e2e/failure-isolation.e2e.ts'], true)).toThrow(
            'Use bun run scripts/run-e2e-failure-isolation.ts',
        );
    });
});

describe('playwrightArguments', () => {
    it('uses the compact reporter and optional focused title filter', () => {
        expect(playwrightArguments(['e2e/smoke.e2e.ts'], 'launches')).toEqual([
            'test',
            'e2e/smoke.e2e.ts',
            '--reporter=line',
            '-g',
            'launches',
        ]);
    });
});

describe('lintPipelineForFile', () => {
    it('matches the repository lint-staged pipelines', () => {
        expect(lintPipelineForFile('src/main/index.ts')).toBe('code');
        expect(lintPipelineForFile('DESIGN.md')).toBe('format');
        expect(lintPipelineForFile('assets/font.woff2')).toBeUndefined();
    });
});

describe('testCandidatesForFile', () => {
    it('runs a changed test directly', () => {
        expect(testCandidatesForFile('src/runtime/foo.test.ts')).toEqual([
            'src/runtime/foo.test.ts',
        ]);
    });

    it('discovers sibling and __tests__ layouts for source files', () => {
        expect(testCandidatesForFile('src/runtime/foo.ts')).toContain(
            'src/runtime/__tests__/foo.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/foo.ts')).toContain('src/runtime/foo.test.ts');
    });

    it('does not infer tests for declarations or documentation', () => {
        expect(testCandidatesForFile('src/shared/global.d.ts')).toEqual([]);
        expect(testCandidatesForFile('README.md')).toEqual([]);
    });

    it('discovers domain integration suites from nested index entries', () => {
        expect(testCandidatesForFile('src/runtime/git/index.ts')).toContain(
            'src/runtime/git/__tests__/git.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/terminal/index.ts')).toContain(
            'src/runtime/terminal/__tests__/terminal.integration.test.ts',
        );
    });

    it('discovers a domain-named integration suite for a nested subdirectory', () => {
        expect(testCandidatesForFile('src/runtime/db/connection.ts')).toContain(
            'src/runtime/db/__tests__/db.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/db/repository.ts')).toContain(
            'src/runtime/db/__tests__/repository.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/files/search.ts')).toEqual(
            expect.arrayContaining([
                'src/runtime/files/__tests__/search.integration.test.ts',
                'src/runtime/files/__tests__/files.integration.test.ts',
            ]),
        );
    });

    it('does not treat a top-level runtime file as a domain integration suite', () => {
        expect(testCandidatesForFile('src/runtime/bootstrap.ts')).not.toContain(
            'src/runtime/__tests__/runtime.integration.test.ts',
        );
    });
});

describe('direct import test selection', () => {
    it('recognizes direct relative static imports and re-exports without following dynamic imports', () => {
        expect(
            testDirectlyImportsSource(
                'src/runtime/files/__tests__/service.test.ts',
                `import { FileService } from '../service';\nexport type { FileServiceOptions } from '../service';`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(true);
        expect(
            testDirectlyImportsSource(
                'src/runtime/files/__tests__/service.test.ts',
                `await import('../service');`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(false);
        expect(
            testDirectlyImportsSource(
                'src/runtime/files/__tests__/other.test.ts',
                `import './other';\nconst note = "import '../service'";`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(false);
    });

    it('selects only direct FileService suites with the existing narrow heuristic', async () => {
        const source = 'src/runtime/files/service.ts';
        const direct = await directImportTestCandidates(process.cwd(), [source]);
        const selected = await selectedTestCandidates(process.cwd(), [source]);

        expect(direct).toEqual([
            'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/files/__tests__/git-ignore.integration.test.ts',
            'src/runtime/files/__tests__/mutations-move-replace.integration.test.ts',
            'src/runtime/files/__tests__/mutations.integration.test.ts',
            'src/runtime/files/__tests__/search.integration.test.ts',
        ]);
        expect(selected).toEqual([
            'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/files/__tests__/git-ignore.integration.test.ts',
            'src/runtime/files/__tests__/mutations-move-replace.integration.test.ts',
            'src/runtime/files/__tests__/mutations.integration.test.ts',
            'src/runtime/files/__tests__/search.integration.test.ts',
        ]);
        expect(selected).not.toContain('src/runtime/__tests__/runtime.integration.test.ts');
        expect(selected).not.toContain('src/runtime/__tests__/agent-hooks.integration.test.ts');
        expect(selected).not.toContain('src/runtime/__tests__/bug-report.test.ts');
    });
});
