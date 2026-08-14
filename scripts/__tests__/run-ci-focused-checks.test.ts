import { describe, expect, it } from 'vitest';

import {
    focusedCheckArguments,
    focusedDiffArguments,
    shouldRunSkillRegressions,
} from '../run-ci-focused-checks';

describe('focused CI checks', () => {
    it('formats and tests documentation or skill changes without a repository-wide typecheck', () => {
        expect(focusedCheckArguments(['docs/testing.md'], 'focused-docs')).toEqual([
            'run',
            '--silent',
            'check',
            'docs/testing.md',
            '--lint',
            '--test',
        ]);
    });

    it('keeps a full type boundary for draft source changes', () => {
        expect(focusedCheckArguments(['src/runtime/index.ts'], 'focused-source')).toEqual([
            'run',
            '--silent',
            'check',
            'src/runtime/index.ts',
            '--lint',
            '--test',
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
        expect(focusedDiffArguments(['docs/testing.md', 'src/runtime/index.ts'])).toEqual([
            'diff',
            '--exit-code',
            '--',
            'docs/testing.md',
            'src/runtime/index.ts',
        ]);
    });

    it('keeps skill regressions required even when every changed skill file was deleted', () => {
        expect(shouldRunSkillRegressions('focused-skills')).toBe(true);
        expect(shouldRunSkillRegressions('focused-docs')).toBe(false);
    });
});
