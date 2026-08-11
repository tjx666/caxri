import { describe, expect, it } from 'vitest';

import { affectsGitIgnoreRules, parentDirectoryPath } from './file-tree-refresh';

describe('file tree refresh routing', () => {
    it('routes each changed path to the directory that directly owns it', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });

    it('recognizes changes that can redecorate every expanded descendant', () => {
        expect(affectsGitIgnoreRules('/project/.gitignore')).toBe(true);
        expect(affectsGitIgnoreRules('/project/packages/app/.gitignore')).toBe(true);
        expect(affectsGitIgnoreRules('/project/.git/info/exclude')).toBe(true);
        expect(affectsGitIgnoreRules('/project/.git/config')).toBe(true);
        expect(affectsGitIgnoreRules('/project/src/index.ts')).toBe(false);
        expect(affectsGitIgnoreRules('/project/local.ignore')).toBe(false);
    });
});
