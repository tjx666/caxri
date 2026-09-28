import { describe, expect, it } from 'vitest';

import {
    buildSurfaceMatrix,
    detectReverseStateGaps,
    parseSurfaceMatrixArguments,
    renderSurfaceMatrixMarkdown,
} from '../surface-matrix';

function surfaceIds(changedFiles: string[]): string[] {
    return buildSurfaceMatrix({ changedFiles }).entries.map((entry) => entry.surface);
}

describe('surface matrix classification', () => {
    it('splits Desktop changes into main, preload, and Renderer surfaces', () => {
        expect(
            surfaceIds([
                'apps/desktop/src/main/root-grants.ts',
                'apps/desktop/src/preload/index.ts',
                'apps/desktop/src/renderer/src/App.tsx',
            ]),
        ).toEqual(['desktop-main', 'desktop-preload', 'desktop-renderer']);
    });

    it('tags a Desktop shared file as main, preload, and Renderer at once', () => {
        const result = buildSurfaceMatrix({
            changedFiles: ['apps/desktop/src/shared/renderer-error-policy.ts'],
        });
        expect(result.entries.map((entry) => entry.surface)).toEqual([
            'desktop-main',
            'desktop-preload',
            'desktop-renderer',
        ]);
        for (const entry of result.entries) {
            expect(entry.files).toEqual(['apps/desktop/src/shared/renderer-error-policy.ts']);
        }
    });

    it('routes a Desktop-root config file to desktop-main as the process owner default', () => {
        expect(surfaceIds(['apps/desktop/package.json'])).toContain('desktop-main');
    });

    it('splits Server changes into Server, Terminal Host, and Extension Host surfaces', () => {
        expect(
            surfaceIds([
                'apps/server/src/domains/git/status.ts',
                'apps/server/src/terminal-host/engine/spawn.ts',
                'apps/server/src/extension-host/api-factory.ts',
            ]),
        ).toEqual(['server', 'terminal-host', 'extension-host']);
    });

    it('keeps Server Core glue for the host processes under the Server surface, not the process surfaces', () => {
        const result = buildSurfaceMatrix({
            changedFiles: [
                'apps/server/src/core/terminal-host/execution.ts',
                'apps/server/src/core/extensions/service.ts',
            ],
        });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.surface).toBe('server');
        expect(result.entries[0]?.files).toEqual([
            'apps/server/src/core/extensions/service.ts',
            'apps/server/src/core/terminal-host/execution.ts',
        ]);
    });

    it('tags every consumer of the shared Server client library', () => {
        expect(surfaceIds(['packages/client/src/supervise/client.ts'])).toEqual([
            'desktop-main',
            'desktop-preload',
            'cli',
        ]);
    });

    it('classifies the CLI app', () => {
        expect(surfaceIds(['apps/cli/src/commands/status.ts'])).toEqual(['cli']);
    });

    it('classifies the Mobile app', () => {
        expect(surfaceIds(['apps/mobile/src/features/terminal/screen.tsx'])).toEqual(['mobile']);
    });

    it('classifies protocol contracts', () => {
        expect(surfaceIds(['packages/protocol/src/domain/terminal.ts'])).toEqual(['protocol']);
    });

    it('classifies bundled extensions', () => {
        expect(surfaceIds(['extensions/git/src/index.ts'])).toEqual(['extensions']);
    });

    it('classifies an ordinary E2E spec', () => {
        expect(surfaceIds(['e2e/terminal-lifecycle.e2e.ts'])).toEqual(['e2e']);
    });

    it('double-tags docs and contributor skills for a SKILL.md edit, matching the fast-merge exception', () => {
        expect(surfaceIds(['.agents/skills/debug/SKILL.md'])).toEqual([
            'docs',
            'contributor-skills',
        ]);
    });

    it('classifies a docs/ page as docs only', () => {
        expect(surfaceIds(['docs/architecture-debt.md'])).toEqual(['docs']);
    });

    it('flags a protected E2E spec as both e2e and CI, since it forces full validation', () => {
        expect(surfaceIds(['e2e/renderer.performance.e2e.ts'])).toEqual(['e2e', 'ci']);
    });

    it('flags a workflow file as CI', () => {
        expect(surfaceIds(['.github/workflows/ci.yml'])).toEqual(['ci']);
    });

    it('flags a full-validation config path as CI in addition to its owning surface', () => {
        expect(surfaceIds(['apps/server/tsconfig.json'])).toEqual(['server', 'ci']);
    });

    it('reports an unrecognized top-level file as unclassified rather than silently dropping it', () => {
        const result = buildSurfaceMatrix({ changedFiles: ['LICENSE'] });
        expect(result.entries).toEqual([]);
        expect(result.unclassifiedFiles).toEqual(['LICENSE']);
    });

    it('covers a mixed diff across Desktop, Server, protocol, and docs in one pass', () => {
        expect(
            surfaceIds([
                'apps/desktop/src/renderer/src/App.tsx',
                'apps/server/src/domains/terminal/suspension.ts',
                'packages/protocol/src/domain/terminal.ts',
                'docs/architecture-debt.md',
            ]),
        ).toEqual(['desktop-renderer', 'server', 'protocol', 'docs']);
    });

    it('deduplicates and sorts changed files before classifying', () => {
        const result = buildSurfaceMatrix({
            changedFiles: [
                'apps/cli/src/commands/b.ts',
                'apps/cli/src/commands/a.ts',
                'apps/cli/src/commands/a.ts',
            ],
        });
        expect(result.entries[0]?.files).toEqual([
            'apps/cli/src/commands/a.ts',
            'apps/cli/src/commands/b.ts',
        ]);
    });
});

describe('reverse-state heuristic', () => {
    it('flags a one-sided create without a paired delete', () => {
        const diffText = ['diff --git a/x b/x', '+function createSession() {}'].join('\n');
        expect(detectReverseStateGaps(diffText)).toEqual(['create/delete']);
    });

    it('does not flag a pair whose reverse also appears added', () => {
        const diffText = [
            'diff --git a/x b/x',
            '+function createSession() {}',
            '+function deleteSession() {}',
        ].join('\n');
        expect(detectReverseStateGaps(diffText)).toEqual([]);
    });

    it('ignores removed lines when deciding whether the reverse exists', () => {
        const diffText = [
            'diff --git a/x b/x',
            '+function enableFeature() {}',
            '-function disableFeature() {}',
        ].join('\n');
        expect(detectReverseStateGaps(diffText)).toEqual(['enable/disable']);
    });

    it('leaves reverse-state unevaluated when no diff text is supplied', () => {
        const result = buildSurfaceMatrix({ changedFiles: ['apps/cli/src/commands/status.ts'] });
        expect(result.reverseState).toEqual({ evaluated: false, gaps: [] });
    });

    it('evaluates reverse-state and reports no gaps for a balanced diff', () => {
        const result = buildSurfaceMatrix({
            changedFiles: ['apps/cli/src/commands/status.ts'],
            diffText: [
                'diff --git a/x b/x',
                '+function grantAccess() {}',
                '+function revokeAccess() {}',
            ].join('\n'),
        });
        expect(result.reverseState).toEqual({ evaluated: true, gaps: [] });
    });
});

describe('surface matrix Markdown rendering', () => {
    it('renders a PENDING status row per surface and the reverse-state section', () => {
        const result = buildSurfaceMatrix({ changedFiles: ['apps/cli/src/commands/status.ts'] });
        const markdown = renderSurfaceMatrixMarkdown(result, {
            base: 'origin/main',
            changedFileCount: 1,
            head: 'abc1234',
        });
        expect(markdown).toContain('## Surface / Proof Matrix');
        expect(markdown).toContain('| CLI |');
        expect(markdown).toContain('PENDING — mark `done` or `waived: <reason>`');
        expect(markdown).toContain('### Reverse-state check');
    });

    it('renders a no-surfaces sentence instead of an empty table', () => {
        const markdown = renderSurfaceMatrixMarkdown(
            buildSurfaceMatrix({ changedFiles: ['LICENSE'] }),
            {
                base: 'origin/main',
                changedFileCount: 1,
                head: 'abc1234',
            },
        );
        expect(markdown).toContain('No tracked product surface matched the changed files.');
        expect(markdown).toContain('Unclassified (no required proof): `LICENSE`');
    });
});

describe('surface matrix CLI argument parsing', () => {
    it('defaults to origin/main with no files and Markdown output', () => {
        expect(parseSurfaceMatrixArguments([])).toEqual({
            base: 'origin/main',
            files: undefined,
            json: false,
        });
    });

    it('parses --base, --files, and --json together', () => {
        expect(
            parseSurfaceMatrixArguments([
                '--base',
                'origin/develop',
                '--files',
                'apps/cli/a.ts, apps/cli/b.ts',
                '--json',
            ]),
        ).toEqual({
            base: 'origin/develop',
            files: ['apps/cli/a.ts', 'apps/cli/b.ts'],
            json: true,
        });
    });

    it('fails closed on an unknown flag', () => {
        expect(() => parseSurfaceMatrixArguments(['--bogus'])).toThrow(
            'Unknown surface-matrix argument: --bogus',
        );
    });

    it('fails closed when --base or --files is missing its value', () => {
        expect(() => parseSurfaceMatrixArguments(['--base'])).toThrow('--base requires a value');
        expect(() => parseSurfaceMatrixArguments(['--files'])).toThrow(
            '--files requires a comma-separated value',
        );
    });
});
