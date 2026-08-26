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
    VITEST_SOURCE_ROOTS,
} from './check';

describe('dirty layer report', () => {
    it('keeps domain-only tests off Renderer, knip, and E2E recommendations', () => {
        expect(
            dirtyLayerReportForFiles(['apps/server/src/domains/files/search.test.ts'], true),
        ).toEqual({
            layers: ['Domains'],
            suggestedGates: [],
        });
    });

    it('recommends Renderer and shared-contract gates without claiming they ran', () => {
        expect(
            dirtyLayerReportForFiles(
                [
                    'apps/desktop/src/renderer/src/features/files/file-tree-panel.tsx',
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

    it('classifies application and package ownership paths', () => {
        expect(
            dirtyLayerReportForFiles(
                [
                    'apps/desktop/src/renderer/src/app.tsx',
                    'apps/server/src/core/app.ts',
                    'apps/cli/src/application.ts',
                    'packages/client/src/index.ts',
                    'packages/system/src/index.ts',
                ],
                true,
            ),
        ).toEqual({
            layers: ['Renderer', 'Server Core', 'System', 'Shared', 'CLI'],
            suggestedGates: ['bun run doctor:changed', 'bun run knip'],
        });
    });
});

describe('parseCheckArguments', () => {
    it('defaults to lint and related tests', () => {
        expect(parseCheckArguments(['apps/desktop/src/main/index.ts'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            files: ['apps/desktop/src/main/index.ts'],
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
            selectE2ESpecs(
                ['apps/desktop/src/main/index.ts', 'e2e/smoke.e2e.ts', 'e2e/settings.e2e.ts'],
                true,
            ),
        ).toEqual(['e2e/smoke.e2e.ts', 'e2e/settings.e2e.ts']);
    });

    it('fails closed without explicit file arguments', () => {
        expect(() => selectE2ESpecs(['e2e/smoke.e2e.ts'], false)).toThrow(
            '--e2e requires an explicit e2e/*.e2e.ts file',
        );
    });

    it('fails closed when explicit files contain no Playwright spec', () => {
        expect(() => selectE2ESpecs(['apps/desktop/src/main/index.ts'], true)).toThrow(
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
        expect(lintPipelineForFile('apps/desktop/src/main/index.ts')).toBe('code');
        expect(lintPipelineForFile('DESIGN.md')).toBe('format');
        expect(lintPipelineForFile('assets/font.woff2')).toBeUndefined();
    });
});

describe('lintBucketsForFiles', () => {
    it('separates Markdown into its own bucket so it can run markdownlint before Prettier', () => {
        expect(
            lintBucketsForFiles([
                'apps/desktop/src/main/index.ts',
                'DESIGN.md',
                'package.json',
                'assets/font.woff2',
            ]),
        ).toEqual({
            codeFiles: ['apps/desktop/src/main/index.ts'],
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
        expect(testCandidatesForFile('apps/server/src/domains/foo.test.ts')).toEqual([
            'apps/server/src/domains/foo.test.ts',
        ]);
    });

    it('discovers sibling and __tests__ layouts for source files', () => {
        expect(testCandidatesForFile('apps/server/src/domains/foo.ts')).toContain(
            'apps/server/src/domains/__tests__/foo.test.ts',
        );
        expect(testCandidatesForFile('apps/server/src/domains/foo.ts')).toContain(
            'apps/server/src/domains/foo.test.ts',
        );
    });

    it('does not infer tests for declarations or documentation', () => {
        expect(testCandidatesForFile('types/build-constants.d.ts')).toEqual([]);
        expect(testCandidatesForFile('README.md')).toEqual([]);
    });

    it('discovers domain integration suites from nested index entries', () => {
        expect(testCandidatesForFile('apps/server/src/domains/git/index.ts')).toContain(
            'apps/server/src/domains/git/__tests__/git.integration.test.ts',
        );
        expect(testCandidatesForFile('apps/server/src/domains/terminal/index.ts')).toContain(
            'apps/server/src/domains/terminal/__tests__/terminal.integration.test.ts',
        );
    });

    it('discovers a domain-named integration suite for a nested subdirectory', () => {
        expect(testCandidatesForFile('apps/server/src/domains/db/connection.ts')).toContain(
            'apps/server/src/domains/db/__tests__/db.integration.test.ts',
        );
        expect(testCandidatesForFile('apps/server/src/domains/db/repository.ts')).toContain(
            'apps/server/src/domains/db/__tests__/repository.integration.test.ts',
        );
        expect(testCandidatesForFile('apps/server/src/domains/files/search.ts')).toEqual(
            expect.arrayContaining([
                'apps/server/src/domains/files/__tests__/search.integration.test.ts',
                'apps/server/src/domains/files/__tests__/files.integration.test.ts',
            ]),
        );
        expect(testCandidatesForFile('packages/agent-skills/src/execute.ts')).toContain(
            'packages/agent-skills/src/__tests__/execute.integration.test.ts',
        );
        expect(testCandidatesForFile('packages/agent-skills/src/filesystem.ts')).toContain(
            'packages/agent-skills/src/__tests__/filesystem.integration.test.ts',
        );
    });

    it('does not treat a top-level runtime file as a domain integration suite', () => {
        expect(
            testCandidatesForFile('apps/server/src/domains/create-domain-services.ts'),
        ).not.toContain('apps/server/src/domains/__tests__/runtime.integration.test.ts');
    });
});

describe('direct import test selection', () => {
    it('recognizes direct relative static imports and re-exports without following dynamic imports', () => {
        expect(
            hasDirectSourceImport(
                'apps/server/src/domains/files/__tests__/service.test.ts',
                `import { FileService } from '../service';\nexport type { FileServiceOptions } from '../service';`,
                'apps/server/src/domains/files/service.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'apps/server/src/domains/files/__tests__/service.test.ts',
                `await import('../service');`,
                'apps/server/src/domains/files/service.ts',
            ),
        ).toBe(false);
        expect(
            hasDirectSourceImport(
                'apps/server/src/domains/files/__tests__/other.test.ts',
                `import './other';\nconst note = "import '../service'";`,
                'apps/server/src/domains/files/service.ts',
            ),
        ).toBe(false);
    });

    it('recognizes tsconfig path-alias static imports', () => {
        expect(
            hasDirectSourceImport(
                'apps/desktop/src/renderer/src/stores/session-view.test.ts',
                `import type { EditorDocument } from '@desktop-shared/editor-state';`,
                'apps/desktop/src/shared/editor-state.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'apps/desktop/src/renderer/src/stores/workbench.test.ts',
                `import { useSessionViewStore } from '@/stores/session-view';`,
                'apps/desktop/src/renderer/src/stores/session-view.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'apps/desktop/src/renderer/src/stores/workbench.test.ts',
                `import { z } from 'zod';`,
                'apps/desktop/src/shared/editor-state.ts',
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

    it('resolves Renderer and Desktop-shared aliases', () => {
        expect(
            hasDirectSourceImport(
                'apps/desktop/src/renderer/src/stores/workbench.test.ts',
                `import { useSessionViewStore } from '@/stores/session-view';`,
                'apps/desktop/src/renderer/src/stores/session-view.ts',
            ),
        ).toBe(true);
        expect(
            hasDirectSourceImport(
                'apps/desktop/src/renderer/src/stores/session-view.test.ts',
                `import type { EditorDocument } from '@desktop-shared/editor-state';`,
                'apps/desktop/src/shared/editor-state.ts',
            ),
        ).toBe(true);
        expect(VITEST_SOURCE_ROOTS).toContain('apps');
    });

    it('selects a test whose only link to the source is an alias import', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'apps/desktop/src/shared/editor-state.ts',
        ]);
        expect(selected).toContain('apps/desktop/src/renderer/src/stores/session-view.test.ts');
    });

    it('discovers direct-import tests inside workspace packages', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'apps/cli/src/application.ts',
        ]);
        expect(selected).toContain('apps/cli/src/commands/__tests__/agent-commands.test.ts');
        expect(selected.every((test) => !test.includes('node_modules'))).toBe(true);
    });

    it('selects only direct FileService suites with the existing narrow heuristic', async () => {
        const source = 'apps/server/src/domains/files/service.ts';
        const direct = await directImportTestCandidates(process.cwd(), [source]);
        const selected = await selectedTestCandidates(process.cwd(), [source]);

        expect(direct).toEqual([
            'apps/server/src/domains/files/__tests__/files.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.watching.integration.test.ts',
            'apps/server/src/domains/files/__tests__/git-ignore.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations-move-replace.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations.integration.test.ts',
            'apps/server/src/domains/files/__tests__/search.integration.test.ts',
            'apps/server/src/domains/files/__tests__/watcher.scope.integration.test.ts',
            'apps/server/src/domains/files/__tests__/workbench-mutations.integration.test.ts',
        ]);
        expect(selected).toEqual([
            'apps/server/src/domains/files/__tests__/files.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.watching.integration.test.ts',
            'apps/server/src/domains/files/__tests__/git-ignore.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations-move-replace.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations.integration.test.ts',
            'apps/server/src/domains/files/__tests__/search.integration.test.ts',
            'apps/server/src/domains/files/__tests__/watcher.scope.integration.test.ts',
            'apps/server/src/domains/files/__tests__/workbench-mutations.integration.test.ts',
        ]);
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/runtime.integration.test.ts',
        );
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/agent-hooks.integration.test.ts',
        );
        expect(selected).not.toContain('apps/server/src/domains/__tests__/bug-report.test.ts');
    });
});
