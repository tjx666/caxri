import { describe, expect, it } from 'vitest';

import { isTraversalExcludedName, isTraversalExcludedPath } from '../ignore-rules';

describe('isTraversalExcludedName', () => {
    it.each([
        '.git',
        '.hg',
        '.svn',
        'node_modules',
        '.next',
        '.nuxt',
        '.turbo',
        '.cache',
        'coverage',
        'dist',
        'build',
        'out',
        'target',
    ])('excludes the %s VCS/build directory name', (name) => {
        expect(isTraversalExcludedName(name)).toBe(true);
    });

    it('excludes SQLite write-ahead-log files by suffix', () => {
        expect(isTraversalExcludedName('caxri.db-wal')).toBe(true);
        expect(isTraversalExcludedName('.db-wal')).toBe(true);
    });

    it.each([
        'src',
        'package.json',
        'README.md',
        'index.ts',
        'dist.txt',
        'building',
        'out-of-scope',
    ])('keeps ordinary project name %s included', (name) => {
        expect(isTraversalExcludedName(name)).toBe(false);
    });

    it('does not match a name that merely contains an excluded suffix elsewhere', () => {
        expect(isTraversalExcludedName('caxri.db-wal.bak')).toBe(false);
    });
});

describe('isTraversalExcludedPath', () => {
    it('excludes a path with an excluded segment at the root', () => {
        expect(isTraversalExcludedPath('node_modules')).toBe(true);
        expect(isTraversalExcludedPath('node_modules/lodash/index.js')).toBe(true);
    });

    it('excludes a path with an excluded segment nested deep inside', () => {
        expect(isTraversalExcludedPath('packages/app/node_modules/lodash/index.js')).toBe(true);
        expect(isTraversalExcludedPath('src/.git/HEAD')).toBe(true);
    });

    it('keeps a path with only ordinary segments included', () => {
        expect(isTraversalExcludedPath('src/runtime/files/ignore-rules.ts')).toBe(false);
        expect(isTraversalExcludedPath('packages/app/src/index.ts')).toBe(false);
    });

    it('does not exclude a segment that merely contains an excluded name as a substring', () => {
        expect(isTraversalExcludedPath('packages/outbound/src/index.ts')).toBe(false);
        expect(isTraversalExcludedPath('packages/rebuild/src/index.ts')).toBe(false);
    });
});
