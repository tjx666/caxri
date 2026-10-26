import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { discoverChangedFiles, selectedTestCandidates } from '../check';

describe('changed-file discovery', () => {
    it('includes committed branch changes and deletions while preserving staged and untracked selection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-check-'));
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        try {
            git('init', '-b', 'main');
            git('config', 'user.name', 'Check Test');
            git('config', 'user.email', 'check@example.invalid');
            await writeFile(join(root, 'base.ts'), 'export const base = 1;\n');
            await writeFile(join(root, 'removed.ts'), 'export const removed = 1;\n');
            await writeFile(join(root, 'renamed.ts'), 'export const renamed = 1;\n');
            git('add', 'base.ts', 'removed.ts', 'renamed.ts');
            git('commit', '-m', 'base');
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            expect(await discoverChangedFiles(root, false)).toEqual([]);

            git('switch', '-c', 'feature');
            await writeFile(join(root, 'committed.ts'), 'export const committed = 1;\n');
            git('add', 'committed.ts');
            git('rm', '-q', 'removed.ts');
            git('mv', 'renamed.ts', 'moved.ts');
            git('commit', '-m', 'feature');
            await writeFile(join(root, 'staged.ts'), 'export const staged = 1;\n');
            git('add', 'staged.ts');
            await writeFile(join(root, 'base.ts'), 'export const base = 2;\n');
            await writeFile(join(root, 'untracked.ts'), 'export const untracked = 1;\n');

            // A rename reports both paths: the removed source is what a stale path reference names.
            expect(await discoverChangedFiles(root, false)).toEqual([
                'base.ts',
                'committed.ts',
                'moved.ts',
                'removed.ts',
                'renamed.ts',
                'staged.ts',
                'untracked.ts',
            ]);
            expect(await discoverChangedFiles(root, true)).toEqual(['staged.ts']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('server domain contract selection', () => {
    it('runs the source-scanning domain structure test for any Runtime domain change', async () => {
        const contract = 'apps/server/src/domains/__tests__/structure.test.ts';

        await expect(
            selectedTestCandidates(process.cwd(), [
                'apps/server/src/domains/agent-chat/service.ts',
            ]),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), ['apps/server/src/core/core-methods.ts']),
        ).resolves.not.toContain(contract);
    });
});

describe('removed-path test selection', () => {
    it('routes removed paths and path-reference configs through the doctor path contract', async () => {
        const contract = 'scripts/__tests__/doctor-config-paths.test.ts';

        await expect(
            selectedTestCandidates(
                process.cwd(),
                ['apps/server/src/domains/theme.ts'],
                ['apps/server/src/domains/theme-moved-away.ts'],
            ),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), ['doctor.config.jsonc']),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), ['apps/server/src/domains/theme.ts']),
        ).resolves.not.toContain(contract);
    });
});

describe('directory density contract selection', () => {
    it('runs the density ratchet for a changed or removed path in a guarded directory', async () => {
        const contract = 'scripts/__tests__/directory-density-ratchet.test.ts';
        const hook =
            'apps/desktop/src/renderer/src/features/agent-chat/hooks/use-agent-chat-scroll.ts';

        await expect(selectedTestCandidates(process.cwd(), [hook])).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(
                process.cwd(),
                ['apps/server/src/domains/theme.ts'],
                ['apps/desktop/src/renderer/src/features/agent-chat/hooks/use-removed.ts'],
            ),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), ['packages/utils/src/index.ts']),
        ).resolves.not.toContain(contract);
    });
});

describe('dependency manifest contract selection', () => {
    it('runs the manifest-reading contracts when a root dependency manifest changes', async () => {
        const contract = 'scripts/__tests__/workspace-dependency-contract.test.ts';

        await expect(
            selectedTestCandidates(process.cwd(), ['pnpm-workspace.yaml']),
        ).resolves.toEqual(
            expect.arrayContaining([contract, 'scripts/__tests__/toolchain-contract.test.ts']),
        );
        await expect(selectedTestCandidates(process.cwd(), ['package.json'])).resolves.toContain(
            contract,
        );
        await expect(
            selectedTestCandidates(process.cwd(), ['apps/mobile/package.json']),
        ).resolves.not.toContain(contract);
    });

    it('runs the workspace-manifest contracts when a workspace package.json changes', async () => {
        const selected = await selectedTestCandidates(process.cwd(), [
            'extensions/status/package.json',
        ]);

        expect(selected).toEqual(
            expect.arrayContaining([
                'scripts/__tests__/toolchain-contract.test.ts',
                'scripts/__tests__/workspace-package-contract.test.ts',
            ]),
        );
        await expect(
            selectedTestCandidates(process.cwd(), ['packages/utils/src/index.ts']),
        ).resolves.not.toContain('scripts/__tests__/workspace-package-contract.test.ts');
    });
});

describe('design-prototype runtime contract selection', () => {
    it('runs the prototype runtime manifest test for a Renderer ui primitive or shared hook change', async () => {
        const contract = '.agents/skills/design-prototype/scripts/build-runtime.test.ts';

        await expect(
            selectedTestCandidates(process.cwd(), [
                'apps/desktop/src/renderer/src/hooks/use-session-excerpts.ts',
            ]),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), [
                'apps/desktop/src/renderer/src/components/ui/tooltip.tsx',
            ]),
        ).resolves.toContain(contract);
        await expect(
            selectedTestCandidates(process.cwd(), [
                'apps/desktop/src/renderer/src/features/settings/keybinding-row-item.tsx',
            ]),
        ).resolves.not.toContain(contract);
    });
});

describe('GitHub config reader test selection', () => {
    it('selects tests that read a changed workflow or composite action as text', async () => {
        const workflowReaders = await selectedTestCandidates(process.cwd(), [
            '.github/workflows/ci.yml',
        ]);
        expect(workflowReaders).toContain(
            '.agents/skills/go/scripts/__tests__/ci-fallback.test.ts',
        );
        expect(workflowReaders).toContain('scripts/__tests__/ci-workflow-contract.test.ts');

        await expect(
            selectedTestCandidates(process.cwd(), ['.github/actions/setup-caxri-job/action.yml']),
        ).resolves.toContain('scripts/__tests__/release-workflow-contract.test.ts');
        await expect(
            selectedTestCandidates(process.cwd(), ['apps/server/src/core/core-methods.ts']),
        ).resolves.not.toContain('scripts/__tests__/ci-workflow-contract.test.ts');
    });
});
