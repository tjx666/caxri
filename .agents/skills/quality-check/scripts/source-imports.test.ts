import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { selectedTestCandidates } from './check';
import {
    directImportTestCandidates,
    hasDirectSourceImport,
    IMPORT_PATH_ALIASES,
    relatedE2ESpecs,
    VITEST_SOURCE_ROOTS,
} from './source-imports';

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

    it('matches a queried import or import.meta.glob by exact file, including non-module sources', () => {
        const testFile = 'scripts/__tests__/example.test.ts';
        const rawImport = "import css from '../../apps/example/theme.css?raw';";
        expect(hasDirectSourceImport(testFile, rawImport, 'apps/example/theme.css')).toBe(true);
        expect(hasDirectSourceImport(testFile, rawImport, 'apps/example/other.css')).toBe(false);
        // A plain module import never selects a stylesheet that merely shares the stem.
        expect(
            hasDirectSourceImport(
                testFile,
                "import '../../apps/example/theme';",
                'apps/example/theme.css',
            ),
        ).toBe(false);

        const globImport = [
            "const files = import.meta.glob<string>(['../../apps/example/ui/*.{ts,tsx}', '!**/skip.ts'], {",
            "    eager: true, import: 'default', query: '?raw',",
            '});',
        ].join('\n');
        expect(hasDirectSourceImport(testFile, globImport, 'apps/example/ui/menu.tsx')).toBe(true);
        expect(hasDirectSourceImport(testFile, globImport, 'apps/example/ui/skip.ts')).toBe(false);
        expect(hasDirectSourceImport(testFile, globImport, 'apps/example/ui/nested/menu.tsx')).toBe(
            false,
        );
    });

    it('selects contract tests that import the Renderer files they assert on', async () => {
        expect(
            await directImportTestCandidates(process.cwd(), [
                'apps/desktop/src/renderer/src/styles/theme.css',
            ]),
        ).toContain('scripts/__tests__/renderer-color-tokens.test.ts');
        expect(
            await directImportTestCandidates(process.cwd(), [
                'apps/desktop/src/renderer/src/features/view-containers/source-control/source-control-history.tsx',
            ]),
        ).toEqual(
            expect.arrayContaining([
                'scripts/__tests__/renderer-controlled-surface-contract.test.ts',
                'scripts/__tests__/source-control-background-refresh-contract.test.ts',
            ]),
        );
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

        // Assert by shape rather than an exhaustive list, so adding a Status suite does not break this contract.
        expect(selected).toContain(
            'extensions/status/src/__tests__/project-status-provider.test.ts',
        );
        expect(selected).toContain('extensions/status/src/__tests__/status-tree.test.ts');
        expect(selected).not.toContain('extensions/status/src/__tests__/status-labels.test.ts');
    });

    it('selects direct FileService suites and bounded barrel consumers', async () => {
        const source = 'apps/server/src/domains/files/service.ts';
        const direct = await directImportTestCandidates(process.cwd(), [source]);
        const selected = await selectedTestCandidates(process.cwd(), [source]);

        const filesSuites = 'apps/server/src/domains/files/__tests__/';
        const consumers = [
            'apps/server/src/domains/__tests__/root-services.test.ts',
            'apps/server/src/domains/__tests__/service-handlers.test.ts',
            'apps/server/src/domains/mobile/__tests__/attention.test.ts',
            'apps/server/src/domains/mobile/__tests__/files.test.ts',
            'apps/server/src/domains/mobile/__tests__/timeline.test.ts',
            'apps/server/src/domains/terminal/__tests__/file-links.test.ts',
        ];
        // Pin the bounded barrel consumers exactly, but assert the FileService suites by shape so
        // adding a suite to the files domain does not break this contract.
        expect(direct.filter((test) => !test.startsWith(filesSuites))).toEqual(consumers);
        expect(direct).toContain(`${filesSuites}files.integration.test.ts`);
        expect(direct).toContain(`${filesSuites}mutations.integration.test.ts`);
        expect(selected.filter((test) => !test.endsWith('/structure.test.ts'))).toEqual(direct);
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/domain-services.integration.test.ts',
        );
        expect(selected).not.toContain(
            'apps/server/src/domains/__tests__/agent-hooks.integration.test.ts',
        );
        expect(selected).not.toContain('apps/server/src/domains/__tests__/bug-report.test.ts');
    });
});
