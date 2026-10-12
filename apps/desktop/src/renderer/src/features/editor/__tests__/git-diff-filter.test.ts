import type { GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { parseGitDiffTab } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    describeHiddenGitDiffFiles,
    filterGitDiffFiles,
    gitChangesDiffTabPathFor,
} from '../git-diff-filter';

const files: GitFileStatus[] = [
    { index: ' ', kind: 'modified', path: 'README.md', workingTree: 'M' },
    { index: ' ', kind: 'modified', path: 'src/example.test.ts', workingTree: 'M' },
    { index: ' ', kind: 'modified', path: 'src/example.spec.ts', workingTree: 'M' },
];

describe('filterGitDiffFiles', () => {
    it('filters enabled repository-relative patterns and reports the hidden count', () => {
        expect(
            filterGitDiffFiles(files, { '**/*.test.*': true, '**/*.spec.*': false }, false),
        ).toEqual({ files: [files[0], files[2]], hiddenCount: 1 });
    });

    it('returns every file when the aggregate tab explicitly shows exclusions', () => {
        expect(filterGitDiffFiles(files, { '**/*.test.*': true }, true)).toEqual({
            files,
            hiddenCount: 0,
        });
    });

    it('distinguishes an all-hidden aggregate from a repository with no changes', () => {
        const filtered = filterGitDiffFiles(
            files.slice(1),
            { '**/*.test.*': true, '**/*.spec.*': true },
            false,
        );

        expect(filtered.files).toEqual([]);
        expect(filtered.hiddenCount).toBe(2);
        expect(describeHiddenGitDiffFiles(filtered.hiddenCount, true, false, translate)).toBe(
            'All 2 changed files are hidden by Git diff exclusions.',
        );
        expect(describeHiddenGitDiffFiles(2_000, true, true, translate)).toBe(
            'All 2,000 loaded changed files are hidden by Git diff exclusions.',
        );
    });
});

describe('gitChangesDiffTabPathFor', () => {
    const workingTab: Extract<GitDiffTab, { kind: 'changes' }> = {
        kind: 'changes',
        repositoryId: 'repo 1',
        repositoryName: 'my project',
        source: 'working',
    };

    it('round-trips the showing state through the aggregate tab resource path', () => {
        expect(parseGitDiffTab(gitChangesDiffTabPathFor(workingTab, true))).toEqual({
            ...workingTab,
            showExcluded: true,
        });
        expect(parseGitDiffTab(gitChangesDiffTabPathFor(workingTab, false))).toEqual(workingTab);
    });

    it('keeps a pull request aggregate on its own resource family', () => {
        const pullRequestTab = { ...workingTab, source: 'pull-request' as const };

        expect(gitChangesDiffTabPathFor(pullRequestTab, true)).toContain('pr-changes/');
        expect(parseGitDiffTab(gitChangesDiffTabPathFor(pullRequestTab, true))).toEqual({
            ...pullRequestTab,
            showExcluded: true,
        });
    });

    it('reproduces the path a hiding tab already occupies so it can be replaced', () => {
        const hidingPath = gitChangesDiffTabPathFor(workingTab, false);
        const parsed = parseGitDiffTab(hidingPath) as Extract<GitDiffTab, { kind: 'changes' }>;

        expect(gitChangesDiffTabPathFor(parsed, false)).toBe(hidingPath);
    });
});
