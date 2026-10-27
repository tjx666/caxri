import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dirtyLayerReportForFiles } from './changed-file-layers';
import {
    ESLINT_CACHE_ARGUMENTS,
    eslintArguments,
    eslintTargets,
    formatCheckSummary,
    lintBucketsForFiles,
    lintPipelineForFile,
    playwrightArguments,
    runLint,
    selectE2ESpecs,
    testCandidatesForFile,
} from './check';
import { parseCheckArguments } from './check-arguments';
import { canAffectTypes, shouldRunKnip, shouldTypecheck } from './default-gates';

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
            ...ESLINT_CACHE_ARGUMENTS,
            '--no-warn-ignored',
            '--max-warnings=0',
            'source.ts',
        ]);
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
            isDefaultSelection: true,
            isStaged: false,
            knip: false,
            lint: true,
            related: false,
            test: true,
            type: false,
        });
    });

    it('rejects a newline-joined file list instead of checking nothing', () => {
        expect(() => parseCheckArguments(['apps/a.ts\napps/b.ts', '--lint'])).toThrow(
            /contains a newline/u,
        );
    });

    it('uses explicit selectors without adding defaults', () => {
        expect(parseCheckArguments(['--staged', '--type'])).toEqual({
            e2e: false,
            e2eGrep: undefined,
            e2eWaitSeconds: undefined,
            files: [],
            isDefaultSelection: false,
            isStaged: true,
            knip: false,
            lint: false,
            related: false,
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
            isDefaultSelection: false,
            isStaged: false,
            knip: true,
            lint: false,
            related: false,
            test: false,
            type: false,
        });
    });

    it('treats --related as an explicit selector that suppresses defaults', () => {
        expect(parseCheckArguments(['--related'])).toMatchObject({
            isDefaultSelection: false,
            lint: false,
            related: true,
            test: false,
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
            isDefaultSelection: false,
            isStaged: false,
            knip: false,
            lint: false,
            related: false,
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
        expect(() => parseCheckArguments(['--e2e', '--e2e-wait', '1801'])).toThrow(
            '--e2e-wait requires an integer from 1 to 1800 seconds',
        );
    });
});

describe('default typecheck selection', () => {
    it('treats sources, tsconfig files, and dependency manifests as type inputs', () => {
        expect(
            [
                'apps/server/src/index.ts',
                'apps/desktop/src/renderer/src/app.tsx',
                'scripts/build.mts',
                'packages/protocol/tsconfig.json',
                'tsconfig.node.json',
                'apps/cli/package.json',
                'pnpm-lock.yaml',
            ].every(canAffectTypes),
        ).toBe(true);
        expect(
            [
                'docs/agent-commander.md',
                'apps/desktop/src/renderer/src/app.css',
                'config.json',
            ].some(canAffectTypes),
        ).toBe(false);
    });

    it('adds the typecheck to the default selection only when a changed path affects types', () => {
        const defaults = parseCheckArguments([]);
        expect(shouldTypecheck(defaults, ['docs/agent-commander.md'])).toBe(false);
        expect(
            shouldTypecheck(defaults, ['docs/agent-commander.md', 'apps/server/src/removed.ts']),
        ).toBe(true);
    });

    it('runs exactly what an explicit selector names', () => {
        expect(shouldTypecheck(parseCheckArguments(['--lint']), ['apps/server/src/index.ts'])).toBe(
            false,
        );
        expect(shouldTypecheck(parseCheckArguments(['--type']), ['docs/agent-commander.md'])).toBe(
            true,
        );
    });

    it('adds knip to the default selection for the same paths, so an orphaned export fails locally', () => {
        const defaults = parseCheckArguments([]);
        expect(shouldRunKnip(defaults, ['docs/agent-commander.md'])).toBe(false);
        expect(shouldRunKnip(defaults, ['scripts/watch-ci.ts'])).toBe(true);
        expect(shouldRunKnip(parseCheckArguments(['--test']), ['scripts/watch-ci.ts'])).toBe(false);
        expect(shouldRunKnip(parseCheckArguments(['--knip']), [])).toBe(true);
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
            ...ESLINT_CACHE_ARGUMENTS,
            '--no-warn-ignored',
            '--max-warnings=0',
            'tools/oxlint/anti-slop/index.ts',
        ]);
    });

    /**
     * Both lint passes share the `lint` script's cache, so a focused check that re-runs after an edit re-lints only the
     * changed bytes. A second cache location would split the entries and leave the repository-wide gate cold.
     */
    it('reuses the lint script cache for every pass', () => {
        const manifest = JSON.parse(
            readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
        ) as {
            scripts: Record<string, string>;
        };
        expect(manifest.scripts.lint).toContain(ESLINT_CACHE_ARGUMENTS.join(' '));
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
        expect(testCandidatesForFile('skills/caxri-cli/SKILL.md')).toEqual(
            expect.arrayContaining([
                'apps/cli/src/__tests__/skills.integration.test.ts',
                'apps/cli/scripts/validate-skill.test.ts',
            ]),
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

    it('does not map a flat domain file onto the domain-services integration suite', () => {
        expect(
            testCandidatesForFile('apps/server/src/domains/create-domain-services.ts'),
        ).not.toContain('apps/server/src/domains/__tests__/domain-services.integration.test.ts');
    });
});
