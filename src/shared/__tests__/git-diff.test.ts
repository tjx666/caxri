import { describe, expect, it } from 'vitest';

import {
    gitChangesDiffTabPath,
    gitDiffModelPath,
    gitDiffTabLabel,
    gitFileDiffTabPath,
    isGitDiffTabPath,
    parseGitDiffTab,
} from '../git-diff';

describe('Git diff tabs', () => {
    it('round-trips file and repository Changes identities without path collisions', () => {
        const file = gitFileDiffTabPath('repo/1', 'src/a#b?c.ts');
        const changes = gitChangesDiffTabPath('repo/1', 'workspace/name');

        expect(parseGitDiffTab(file)).toEqual({
            kind: 'file',
            path: 'src/a#b?c.ts',
            repositoryId: 'repo/1',
        });
        expect(parseGitDiffTab(changes)).toEqual({
            kind: 'changes',
            repositoryId: 'repo/1',
            repositoryName: 'workspace/name',
        });
        expect(isGitDiffTabPath('/project/src/a.ts')).toBe(false);
    });

    it('provides readable labels and distinct original and modified Monaco model URIs', () => {
        const tab = parseGitDiffTab(gitFileDiffTabPath('repo', 'src/file.ts'))!;
        const original = gitDiffModelPath('session', 'repo', 'src/file.ts', 'original');
        const modified = gitDiffModelPath('session', 'repo', 'src/file.ts', 'modified');

        expect(gitDiffTabLabel(tab)).toBe('file.ts');
        expect(original).not.toBe(modified);
        expect(original).toMatch(/\/src\/file\.ts$/);
    });
});
