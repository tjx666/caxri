/* eslint-disable unicorn/name-replacements -- Keep the test aligned with the repository path helper API. */

import { describe, expect, it } from 'vitest';

import { resolveRepositoryFilePath as resolveRepoFilePath } from './repository-file-path';

describe('resolveRepositoryFilePath', () => {
    it('resolves files against primary and nested repository roots', () => {
        expect(resolveRepoFilePath('/repo', 'src/index.ts')).toBe('/repo/src/index.ts');
        expect(resolveRepoFilePath('/repo/nested/', 'src/index.ts')).toBe(
            '/repo/nested/src/index.ts',
        );
        expect(resolveRepoFilePath('/', 'src/index.ts')).toBe('/src/index.ts');
        expect(resolveRepoFilePath('/repo', 'name…with.ts')).toBe('/repo/name…with.ts');
    });

    it('rejects paths that are not safe repository-relative values', () => {
        expect(resolveRepoFilePath(undefined, 'src/index.ts')).toBeUndefined();
        expect(resolveRepoFilePath('repo', 'src/index.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo\0', 'src/index.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', 'src\0/index.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', '/etc/passwd')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', '../outside.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', 'src/../outside.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', 'src//index.ts')).toBeUndefined();
        expect(resolveRepoFilePath('/repo', './index.ts')).toBeUndefined();
    });
});

/* eslint-enable unicorn/name-replacements */
