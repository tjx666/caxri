import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
    directImportTestCandidates,
    dirtyLayerReportForFiles,
    discoverChangedFiles,
    eslintArguments,
    eslintTargets,
    formatCheckSummary,
    hasDirectSourceImport,
    IMPORT_PATH_ALIASES,
    lintBucketsForFiles,
    lintPipelineForFile,
    parseCheckArguments,
    playwrightArguments,
    relatedE2ESpecs,
    runLint,
    selectE2ESpecs,
    selectedTestCandidates,
    testCandidatesForFile,
    VITEST_SOURCE_ROOTS,
} from './check';

describe('final lint validation', () => {
    it('checks formatted bytes without mutating them and propagates final failures', async () => {
        const calls: Array<{ executable: string; arguments: string[] }> = [];
        const run = (_root: string, executable: string, arguments_: string[]) => {
            calls.push({ executable, arguments: arguments_ });
            if (executable === 'eslint' && !arguments_.includes('--fix'))
                return Promise.reject(new Error('Formatted file exceeds max-lines'));
            return Promise.resolve();
        };
        await expect(runLint('/fixture', ['source.ts'], run)).rejects.toThrow('exceeds max-lines');
        expect(calls.map(({ executable }) => executable)).toEqual([
            'eslint',
            'oxlint',
            'prettier',
            'eslint',
        ]);
        expect(calls.at(-1)?.arguments).toEqual([
            '--no-warn-ignored',
            '--max-warnings=0',
            'source.ts',
        ]);
    });
});

describe('changed-file discovery', () => {
    it('includes committed branch changes while preserving staged and untracked selection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-check-'));
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        try {
            git('init', '-b', 'main');
            git('config', 'user.name', 'Check Test');
            git('config', 'user.email', 'check@example.invalid');
            await writeFile(join(root, 'base.ts'), 'export const base = 1;\n');
            git('add', 'base.ts');
            git('commit', '-m', 'base');
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            expect(await discoverChangedFiles(root, false)).toEqual([]);

            git('switch', '-c', 'feature');
            await writeFile(join(root, 'committed.ts'), 'export const committed = 1;\n');
            git('add', 'committed.ts');
            git('commit', '-m', 'feature');
            await writeFile(join(root, 'staged.ts'), 'export const staged = 1;\n');
            git('add', 'staged.ts');
            await writeFile(join(root, 'base.ts'), 'export const base = 2;\n');
            await writeFile(join(root, 'untracked.ts'), 'export const untracked = 1;\n');

            expect(await discoverChangedFiles(root, false)).toEqual([
                'base.ts',
                'committed.ts',
                'staged.ts',
                'untracked.ts',
            ]);
            expect(await discoverChangedFiles(root, true)).toEqual(['staged.ts']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('dirty layer report', () => {
    it('keeps domain-only tests off knip and E2E recommendations but still routes them to React Doctor', () => {
        expect(
            dirtyLayerReportForFiles(['apps/server/src/domains/files/search.test.ts'], true),
        ).toEqual({
            layers: ['Domains'],
            suggestedGates: ['bun run doctor:changed'],
        });
    });

    it('routes every changed TypeScript file to React Doctor, whatever layer owns it', () => {
        /**
         * CI runs React Doctor over all changed TypeScript, and its plain JavaScript rules are not Renderer-only.
         */
        expect(
            dirtyLayerReportForFiles(['apps/server/src/domains/agents/title-generation.ts'], true)
                .suggestedGates,
        ).toEqual(['bun run doctor:changed']);
        expect(
            dirtyLayerReportForFiles(['docs/low-cost-generation.md'], true).suggestedGates,
        ).toEqual([]);
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
            suggestedGates: ['bun run doctor:changed', '--e2e'],
        });
        expect(dirtyLayerReportForFiles(['e2e/smoke.e2e.ts'], false)).toEqual({
            layers: ['e2e'],
            suggestedGates: ['bun run doctor:changed'],
        });
        expect(dirtyLayerReportForFiles(['e2e/support/fixtures.ts'], true)).toEqual({
            layers: ['e2e'],
            suggestedGates: ['bun run doctor:changed'],
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
                'bun run doctor:changed',
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
                    'apps/server/src/core/server-core.ts',
                    'apps/mobile/src/features/sessions/session-model.ts',
                    'apps/cli/src/application.ts',
                    'packages/client/src/index.ts',
                    'packages/mobile-transport/src/index.ts',
                    'packages/system/src/index.ts',
                ],
                true,
            ),
        ).toEqual({
            layers: [
                'Renderer',
                'Server Core',
                'Mobile',
                'System',
                'Shared',
                'Mobile Transport',
                'CLI',
            ],
            suggestedGates: ['bun run doctor:changed', 'bun run knip'],
        });
    });
});

describe('parseCheckArguments', () => {
    it('defaults to lint and related tests', () => {
        expect(parseCheckArguments(['apps/desktop/src/main/index.ts'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            e2eWaitSeconds: undefined,
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
            e2eWaitSeconds: undefined,
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
            e2eWaitSeconds: undefined,
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
            e2eWaitSeconds: undefined,
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

    it('accepts only a bounded desktop lease wait for e2e', () => {
        expect(
            parseCheckArguments(['e2e/smoke.e2e.ts', '--e2e', '--e2e-wait', '30']),
        ).toMatchObject({ e2eWaitSeconds: 30 });
        expect(() => parseCheckArguments(['--e2e-wait', '30'])).toThrow(
            '--e2e-wait requires --e2e',
        );
        expect(() => parseCheckArguments(['--e2e', '--e2e-wait', '301'])).toThrow(
            '--e2e-wait requires an integer from 1 to 300 seconds',
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
        expect(lintPipelineForFile('scripts/config.mts')).toBe('code');
        expect(lintPipelineForFile('scripts/config.cts')).toBe('code');
        expect(lintPipelineForFile('DESIGN.md')).toBe('format');
        expect(lintPipelineForFile('assets/font.woff2')).toBeUndefined();
    });
});

describe('eslintArguments', () => {
    /**
     * The zero-warning threshold is the load-bearing part: ESLint exits 0 on a warning, so omitting it let a focused
     * check pass on a file the `lint` gate rejects.
     */
    it('silences intentionally ignored files while keeping the zero-warning threshold', () => {
        expect(eslintArguments(['tools/oxlint/anti-slop/index.ts'])).toEqual([
            '--fix',
            '--no-warn-ignored',
            '--max-warnings=0',
            'tools/oxlint/anti-slop/index.ts',
        ]);
    });
});

describe('eslintTargets', () => {
    /**
     * ESLint lints fenced JS/TS blocks in Markdown, so a doc snippet can fail the repository-wide `lint` gate. Skipping
     * `.md` here let exactly that pass a focused check and fail CI.
     */
    it('lints Markdown alongside code, and leaves other formatted files to Prettier', () => {
        expect(
            eslintTargets(
                lintBucketsForFiles([
                    'apps/desktop/src/main/index.ts',
                    '.agents/skills/audit-ux/references/render-layer.md',
                    'package.json',
                ]),
            ),
        ).toEqual([
            'apps/desktop/src/main/index.ts',
            '.agents/skills/audit-ux/references/render-layer.md',
        ]);
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

    it('selects repository harness contracts for instruction, skill, and hook changes', () => {
        expect(testCandidatesForFile('.agents/invocation.md')).toContain(
            'scripts/__tests__/skill-invocation.test.ts',
        );
        expect(testCandidatesForFile('CLAUDE.md')).toContain(
            'scripts/__tests__/skill-invocation.test.ts',
        );
        expect(testCandidatesForFile('.agents/skills/competitors/SKILL.md')).toContain(
            'scripts/__tests__/skill-invocation.test.ts',
        );
        expect(testCandidatesForFile('skills/caxri-cli/SKILL.md')).toContain(
            'apps/cli/src/__tests__/skills.integration.test.ts',
        );
        expect(testCandidatesForFile('.agents/skills/debug/agents/openai.yaml')).toContain(
            'scripts/__tests__/skill-invocation.test.ts',
        );
        expect(testCandidatesForFile('.claude/settings.json')).toContain(
            '.agents/skills/acceptance/scripts/project-hook.test.ts',
        );
        expect(testCandidatesForFile('.codex/hooks.json')).toContain(
            '.agents/skills/acceptance/scripts/project-hook.test.ts',
        );
        expect(testCandidatesForFile('.agents/skills/go/scripts/state.ts')).not.toContain(
            'scripts/__tests__/skill-invocation.test.ts',
        );
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
    it('routes Renderer source changes through both global scan contracts', async () => {
        const selected = await selectedTestCandidates(process.cwd(), [
            'apps/desktop/src/renderer/src/features/files/file-tree-panel.tsx',
        ]);
        expect(selected).toEqual(
            expect.arrayContaining([
                'apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts',
                'apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts',
            ]),
        );

        const unrelated = await selectedTestCandidates(process.cwd(), [
            'apps/server/src/domains/theme.ts',
        ]);
        expect(unrelated).not.toContain(
            'apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts',
        );
        expect(unrelated).not.toContain(
            'apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts',
        );
    });

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

    it('selects workspace package consumers through bounded re-export barrels', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'packages/protocol/src/domain/session.ts',
        ]);
        expect(selected).toContain('packages/protocol/src/__tests__/contracts.test.ts');
        expect(selected).toContain('apps/server/src/domains/db/__tests__/repo.integration.test.ts');
        expect(
            await relatedE2ESpecs(process.cwd(), ['packages/protocol/src/domain/session.ts']),
        ).toContain('e2e/terminal-shortcuts.e2e.ts');
    });

    it('follows pure barrels for at most two hops without traversing ordinary imports', () => {
        const testFile = 'apps/server/src/example.test.ts';
        const source = 'packages/example/src/source.ts';
        const workspaceEntries = new Map([['@caxri/example', 'packages/example/src/index.ts']]);
        const barrelContents = new Map([
            ['packages/example/src/index', "export * from './middle.js';"],
            ['packages/example/src/middle', "export * from './source.js';"],
        ]);
        const testContents = "import { source } from '@caxri/example';";
        expect(
            hasDirectSourceImport(testFile, testContents, source, {
                barrelContents,
                workspaceEntries,
            }),
        ).toBe(true);
        barrelContents.set(
            'packages/example/src/middle',
            "import './source.js';\nexport * from './other.js';",
        );
        expect(
            hasDirectSourceImport(testFile, testContents, source, {
                barrelContents,
                workspaceEntries,
            }),
        ).toBe(false);
        barrelContents.set('packages/example/src/middle', "export * from './third.js';");
        barrelContents.set('packages/example/src/third', "export * from './source.js';");
        expect(
            hasDirectSourceImport(testFile, testContents, source, {
                barrelContents,
                workspaceEntries,
            }),
        ).toBe(false);
    });

    it('runs a skill\u{2019}s own contract tests when its SKILL.md changes', async () => {
        const selected = await selectedTestCandidates(process.cwd(), [
            '.agents/skills/e2e-testing/SKILL.md',
        ]);
        expect(selected).toContain('.agents/skills/e2e-testing/scripts/skill-routing.test.ts');
        expect(selected).toContain('scripts/__tests__/skill-invocation.test.ts');
        expect(selected.some((test) => test.startsWith('.agents/skills/quality-check/'))).toBe(
            false,
        );
    });

    it('discovers direct-import tests inside workspace packages', async () => {
        const selected = await directImportTestCandidates(process.cwd(), [
            'apps/cli/src/application.ts',
        ]);
        expect(selected).toContain('apps/cli/src/commands/__tests__/agent-commands.test.ts');
        expect(selected.every((test) => !test.includes('node_modules'))).toBe(true);
    });

    it('discovers direct-import tests inside bundled extensions across file names', async () => {
        expect(VITEST_SOURCE_ROOTS).toContain('extensions');
        const selected = await directImportTestCandidates(process.cwd(), [
            'extensions/status/src/extension.ts',
            'extensions/status/src/status-tree.ts',
        ]);

        expect(selected).toEqual([
            'extensions/status/src/__tests__/project-status-provider.test.ts',
            'extensions/status/src/__tests__/status-fallback.test.ts',
            'extensions/status/src/__tests__/status-review-threads.test.ts',
            'extensions/status/src/__tests__/status-tree-acceptance.test.ts',
            'extensions/status/src/__tests__/status-tree-branch.test.ts',
            'extensions/status/src/__tests__/status-tree.test.ts',
        ]);
    });

    it('selects direct FileService suites and bounded barrel consumers', async () => {
        const source = 'apps/server/src/domains/files/service.ts';
        const direct = await directImportTestCandidates(process.cwd(), [source]);
        const selected = await selectedTestCandidates(process.cwd(), [source]);

        const expected = [
            'apps/server/src/domains/__tests__/root-services.test.ts',
            'apps/server/src/domains/__tests__/service-handlers.test.ts',
            'apps/server/src/domains/files/__tests__/external-links.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.browse.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.imports.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.integration.test.ts',
            'apps/server/src/domains/files/__tests__/files.watching.integration.test.ts',
            'apps/server/src/domains/files/__tests__/git-ignore.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations-move-replace.integration.test.ts',
            'apps/server/src/domains/files/__tests__/mutations.integration.test.ts',
            'apps/server/src/domains/files/__tests__/search.integration.test.ts',
            'apps/server/src/domains/files/__tests__/watcher.scope.integration.test.ts',
            'apps/server/src/domains/files/__tests__/workbench-mutations.integration.test.ts',
            'apps/server/src/domains/mobile/__tests__/files.test.ts',
            'apps/server/src/domains/mobile/__tests__/timeline.test.ts',
            'apps/server/src/domains/terminal/__tests__/file-links.test.ts',
        ];
        expect(direct).toEqual(expected);
        expect(selected).toEqual(expected);
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/runtime.integration.test.ts',
        );
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/agent-hooks.integration.test.ts',
        );
        expect(selected).not.toContain('apps/server/src/domains/__tests__/bug-report.test.ts');
    });
});
