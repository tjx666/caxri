import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
    directImportTestCandidates,
    dirtyLayerReportForFiles,
    formatCheckSummary,
    hasDirectSourceImport,
    IMPORT_PATH_ALIASES,
    lintBucketsForFiles,
    lintPipelineForFile,
    parseCheckArguments,
    playwrightArguments,
    selectE2ESpecs,
    selectedTestCandidates,
    testCandidatesForFile,
} from './check';

describe('dirty layer report', () => {
    it('keeps Runtime-only tests off Renderer, knip, and E2E recommendations', () => {
        expect(dirtyLayerReportForFiles(['src/runtime/files/search.test.ts'], true)).toEqual({
            layers: ['Runtime'],
            suggestedGates: [],
        });
    });

    it('recommends Renderer and shared-contract gates without claiming they ran', () => {
        expect(
            dirtyLayerReportForFiles(
                [
                    'src/renderer/src/features/files/file-tree-panel.tsx',
                    'packages/protocol/src/domain/session.ts',
                ],
                true,
            ),
        ).toEqual({
            layers: ['Renderer', 'IPC'],
            suggestedGates: ['bun run doctor:changed', 'bun run knip'],
        });

        const summary = formatCheckSummary({
            changedFileCount: 2,
            dirtyLayers: ['Renderer', 'IPC'],
            executedChecks: ['lint 2', 'tests 1'],
            suggestedGates: ['bun run doctor:changed', 'bun run knip'],
        });
        expect(summary).toContain('suggested gates bun run doctor:changed, bun run knip');
        expect(summary).toContain('ran lint 2 · tests 1');
        expect(summary).not.toContain('ran knip');
    });

    it('suggests --e2e only for explicitly selected Playwright specs', () => {
        expect(dirtyLayerReportForFiles(['e2e/smoke.e2e.ts'], true)).toEqual({
            layers: ['e2e'],
            suggestedGates: ['--e2e'],
        });
        expect(dirtyLayerReportForFiles(['e2e/smoke.e2e.ts'], false)).toEqual({
            layers: ['e2e'],
            suggestedGates: [],
        });
        expect(dirtyLayerReportForFiles(['e2e/support/fixtures.ts'], true)).toEqual({
            layers: ['e2e'],
            suggestedGates: [],
        });
    });

    it('routes protected Playwright specs to their dedicated gates', () => {
        expect(
            dirtyLayerReportForFiles(
                ['e2e/real-agent-smoke.e2e.ts', 'e2e/failure-isolation.e2e.ts'],
                true,
            ),
        ).toEqual({
            layers: ['e2e'],
            suggestedGates: [
                'bun run test:e2e:real-agent',
                'bun run scripts/run-e2e-failure-isolation.ts',
            ],
        });
    });

    it('classifies contributor skills and non-code documentation independently', () => {
        expect(
            dirtyLayerReportForFiles(['.agents/skills/go/SKILL.md', 'docs/architecture.md'], true),
        ).toEqual({
            layers: ['skills', 'docs'],
            suggestedGates: [],
        });
    });
});

describe('parseCheckArguments', () => {
    it('defaults to lint and related tests', () => {
        expect(parseCheckArguments(['src/main/index.ts'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: ['src/main/index.ts'],
            isStaged: false,
            knip: false,
            lint: true,
            test: true,
            type: false,
        });
    });

    it('uses explicit selectors without adding defaults', () => {
        expect(parseCheckArguments(['--staged', '--type'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: [],
            isStaged: true,
            knip: false,
            lint: false,
            test: false,
            type: true,
        });
    });

    it('treats --knip as an explicit selector that suppresses defaults', () => {
        expect(parseCheckArguments(['--knip'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: [],
            isStaged: false,
            knip: true,
            lint: false,
            test: false,
            type: false,
        });
    });

    it('selects focused Playwright coverage without adding default checks', () => {
        expect(
            parseCheckArguments([
                'e2e/smoke.e2e.ts',
                '--e2e',
                '--e2e-grep',
                'launches the workbench',
            ]),
        ).toEqual({
            e2e: true,
            e2eGrep: 'launches the workbench',
            files: ['e2e/smoke.e2e.ts'],
            isStaged: false,
            knip: false,
            lint: false,
            test: false,
            type: false,
        });
    });

    it('rejects an e2e grep without the e2e selector', () => {
        expect(() => parseCheckArguments(['--e2e-grep', 'launches'])).toThrow(
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

describe('lintBucketsForFiles', () => {
    it('separates Markdown into its own bucket so it can run markdownlint before Prettier', () => {
        expect(
            lintBucketsForFiles([
                'src/main/index.ts',
                'DESIGN.md',
                'package.json',
                'assets/font.woff2',
            ]),
        ).toEqual({
            codeFiles: ['src/main/index.ts'],
            markdownFiles: ['DESIGN.md'],
            otherFormatFiles: ['package.json'],
        });
    });

    it('matches Markdown extensions case-insensitively, same as lintPipelineForFile', () => {
        expect(lintBucketsForFiles(['README.MD']).markdownFiles).toEqual(['README.MD']);
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
        expect(testCandidatesForFile('packages/cli/src/skills/execute.ts')).toContain(
            'packages/cli/src/skills/__tests__/skills.integration.test.ts',
        );
        expect(testCandidatesForFile('packages/cli/src/skills/filesystem.ts')).toContain(
            'packages/cli/src/skills/__tests__/skills.integration.test.ts',
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
            hasDirectSourceImport(
                'src/runtime/files/__tests__/service.test.ts',
                `import { FileService } from '../service';\nexport type { FileServiceOptions } from '../service';`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'src/runtime/files/__tests__/service.test.ts',
                `await import('../service');`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(false);
        expect(
            hasDirectSourceImport(
                'src/runtime/files/__tests__/other.test.ts',
                `import './other';\nconst note = "import '../service'";`,
                'src/runtime/files/service.ts',
            ),
        ).toBe(false);
    });

    it('recognizes tsconfig path-alias static imports', () => {
        expect(
            hasDirectSourceImport(
                'src/renderer/src/stores/workbench.test.ts',
                `import type { RuntimeEvent } from '@shared/ipc/events';`,
                'src/shared/ipc/events.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'src/renderer/src/stores/workbench.test.ts',
                `import { useSessionViewStore } from '@/stores/session-view';`,
                'src/renderer/src/stores/session-view.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'src/renderer/src/stores/workbench.test.ts',
                `import { z } from 'zod';`,
                'src/shared/ipc/events.ts',
            ),
        ).toBe(false);
    });

    it('mirrors the root tsconfig path aliases exactly', async () => {
        const tsconfig = JSON.parse(await readFile('tsconfig.json', 'utf8')) as {
            compilerOptions: { paths: Record<string, string[]> };
        };
        const expected = Object.entries(tsconfig.compilerOptions.paths).map(
            ([pattern, targets]) => ({
                prefix: pattern.replace(/\*$/, ''),
                target: targets[0].replace(/^\.\//, '').replace(/\*$/, ''),
            }),
        );
        expect([...IMPORT_PATH_ALIASES]).toEqual(expected);
    });

    it('selects a test whose only link to the source is an alias import', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'src/shared/ipc/events.ts',
        ]);
        expect(selected).toContain('src/renderer/src/stores/workbench.test.ts');
    });

    it('discovers direct-import tests inside workspace packages', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'packages/cli/src/application.ts',
        ]);
        expect(selected).toContain('packages/cli/src/commands/__tests__/agent-commands.test.ts');
        expect(selected.every((test) => !test.includes('node_modules'))).toBe(true);
    });

    it('selects only direct FileService suites with the existing narrow heuristic', async () => {
        const source = 'src/runtime/files/service.ts';
        const direct = await directImportTestCandidates(process.cwd(), [source]);
        const selected = await selectedTestCandidates(process.cwd(), [source]);

        expect(direct).toEqual([
            'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/files/__tests__/files.watching.integration.test.ts',
            'src/runtime/files/__tests__/git-ignore.integration.test.ts',
            'src/runtime/files/__tests__/mutations-move-replace.integration.test.ts',
            'src/runtime/files/__tests__/mutations.integration.test.ts',
            'src/runtime/files/__tests__/search.integration.test.ts',
            'src/runtime/files/__tests__/watcher.scope.integration.test.ts',
            'src/runtime/files/__tests__/workbench-mutations.integration.test.ts',
        ]);
        expect(selected).toEqual([
            'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/files/__tests__/files.watching.integration.test.ts',
            'src/runtime/files/__tests__/git-ignore.integration.test.ts',
            'src/runtime/files/__tests__/mutations-move-replace.integration.test.ts',
            'src/runtime/files/__tests__/mutations.integration.test.ts',
            'src/runtime/files/__tests__/search.integration.test.ts',
            'src/runtime/files/__tests__/watcher.scope.integration.test.ts',
            'src/runtime/files/__tests__/workbench-mutations.integration.test.ts',
        ]);
        expect(selected).not.toContain('src/runtime/__tests__/runtime.integration.test.ts');
        expect(selected).not.toContain('src/runtime/__tests__/agent-hooks.integration.test.ts');
        expect(selected).not.toContain('src/runtime/__tests__/bug-report.test.ts');
    });
});
