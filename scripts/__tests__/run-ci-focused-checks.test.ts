import { describe, expect, it } from 'vitest';

import {
    focusedCheckArguments,
    focusedDiffArguments,
    focusedRegressionPaths,
    shouldRunReactDoctor,
    shouldRunSkillRegressions,
} from '../run-ci-focused-checks';

describe('focused CI checks', () => {
    it('runs React Doctor for an affected Desktop or Mobile source change only', () => {
        const renderer =
            'apps/desktop/src/renderer/src/features/agent-chat/composer/agent-chat-composer.tsx';
        expect(shouldRunReactDoctor('affected', [renderer])).toBe(true);
        expect(shouldRunReactDoctor('affected', ['apps/mobile/src/app/index.ts'])).toBe(true);
        expect(shouldRunReactDoctor('affected', ['apps/server/src/domains/git/index.ts'])).toBe(
            false,
        );
        expect(shouldRunReactDoctor('affected', ['apps/desktop/README.md'])).toBe(false);
        // Draft and focused scopes keep their cheaper gate set; the `full` scope runs it from the platform gates.
        expect(shouldRunReactDoctor('focused-source', [renderer])).toBe(false);
    });

    it('runs the directory density ratchet when an affected or draft source change touches a guarded directory', () => {
        const guard = 'scripts/__tests__/directory-density-ratchet.test.ts';
        // A new file is not imported by the ratchet (it reads the filesystem), so `vitest related` cannot reach it.
        const added = ['apps/desktop/src/main/brand-new-module.ts'];
        expect(focusedRegressionPaths('affected', added, added)).toEqual([guard]);
        expect(focusedRegressionPaths('focused-source', added, added)).toEqual([guard]);
        // A pure deletion must also run it so the baseline gets tightened.
        expect(focusedRegressionPaths('affected', added)).toEqual([guard]);
        expect(
            focusedRegressionPaths('affected', ['apps/server/src/domains/agent-chat/claude-x.ts']),
        ).toEqual([guard]);
        expect(
            focusedRegressionPaths('affected', [
                'apps/desktop/src/renderer/src/features/agent-chat/new-thing.tsx',
            ]),
        ).toEqual([guard]);
        expect(
            focusedRegressionPaths('affected', ['apps/server/src/domains/git/index.ts']),
        ).toEqual([]);
    });

    it('formats and tests documentation or skill changes without a repository-wide typecheck', () => {
        expect(focusedCheckArguments(['docs/testing.md'], 'focused-docs')).toEqual([
            'run',
            '--silent',
            'check',
            'docs/testing.md',
            '--lint',
            '--test',
        ]);
        expect(focusedCheckArguments(['.claude/settings.json'], 'focused-harness')).toEqual([
            'run',
            '--silent',
            'check',
            '.claude/settings.json',
            '--lint',
            '--test',
        ]);
    });

    it('keeps a full type boundary for draft source changes', () => {
        expect(
            focusedCheckArguments(['apps/server/src/domains/index.ts'], 'focused-source'),
        ).toEqual([
            'run',
            '--silent',
            'check',
            'apps/server/src/domains/index.ts',
            '--lint',
            '--test',
            '--type',
        ]);
    });

    it('does not run Vitest for a focused E2E spec repair', () => {
        expect(focusedCheckArguments(['e2e/session-attention.e2e.ts'], 'focused-e2e')).toEqual([
            'run',
            '--silent',
            'check',
            'e2e/session-attention.e2e.ts',
            '--lint',
            '--type',
        ]);
    });

    it('keeps type validation on repository-skill changes', () => {
        expect(
            focusedCheckArguments(
                ['.agents/skills/switch-worktree/scripts/desktop-lease.ts'],
                'focused-skills',
            ),
        ).toEqual([
            'run',
            '--silent',
            'check',
            '.agents/skills/switch-worktree/scripts/desktop-lease.ts',
            '--lint',
            '--test',
            '--type',
        ]);
    });

    it('fails closed when the checker auto-fixes a tracked input', () => {
        expect(
            focusedDiffArguments(['docs/testing.md', 'apps/server/src/domains/index.ts']),
        ).toEqual([
            'diff',
            '--exit-code',
            '--',
            'docs/testing.md',
            'apps/server/src/domains/index.ts',
        ]);
    });

    it('keeps skill regressions required even when every changed skill file was deleted', () => {
        expect(shouldRunSkillRegressions('focused-skills')).toBe(true);
        expect(shouldRunSkillRegressions('focused-docs')).toBe(false);
    });

    it('runs repository harness contracts for deleted bridge paths', () => {
        expect(focusedRegressionPaths('focused-harness', ['.agents/invocation.md'])).toEqual([
            'scripts/__tests__/skill-invocation.test.ts',
        ]);
        expect(focusedRegressionPaths('focused-harness', ['.claude/skills'])).toEqual([
            'scripts/__tests__/skill-invocation.test.ts',
        ]);
        expect(focusedRegressionPaths('focused-harness', ['.claude/settings.json'])).toEqual([
            '.agents/skills/acceptance/scripts/project-hook.test.ts',
        ]);
        expect(focusedRegressionPaths('focused-skills', ['.agents/skills/debug/SKILL.md'])).toEqual(
            ['.agents/skills', 'scripts/__tests__/skill-invocation.test.ts'],
        );
        expect(focusedRegressionPaths('focused-docs', ['docs/testing.md'])).toEqual([]);
    });

    it('does not repeat contracts already selected by the changed-file check', () => {
        expect(
            focusedRegressionPaths(
                'focused-harness',
                ['.agents/invocation.md'],
                ['.agents/invocation.md'],
            ),
        ).toEqual([]);
        expect(
            focusedRegressionPaths(
                'focused-harness',
                ['.claude/settings.json'],
                ['.claude/settings.json'],
            ),
        ).toEqual([]);
        expect(
            focusedRegressionPaths(
                'focused-skills',
                ['.agents/skills/debug/SKILL.md'],
                ['.agents/skills/debug/SKILL.md'],
            ),
        ).toEqual(['.agents/skills']);
    });

    it('lints, typechecks, and runs knip for affected changes', () => {
        expect(focusedCheckArguments(['apps/server/src/index.ts'], 'affected')).toEqual([
            'run',
            '--silent',
            'check',
            'apps/server/src/index.ts',
            '--lint',
            '--type',
            '--knip',
        ]);
        for (const scope of ['focused-source', 'focused-docs', 'focused-e2e'] as const) {
            expect(focusedCheckArguments(['a.ts'], scope)).not.toContain('--knip');
        }
    });
});
