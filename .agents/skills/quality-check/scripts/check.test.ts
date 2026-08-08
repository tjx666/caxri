import { describe, expect, it } from 'vitest';

import { lintPipelineForFile, parseCheckArgs, testCandidatesForFile } from './check';

describe('parseCheckArgs', () => {
    it('defaults to lint and related tests', () => {
        expect(parseCheckArgs(['src/main/index.ts'])).toEqual({
            files: ['src/main/index.ts'],
            knip: false,
            lint: true,
            staged: false,
            test: true,
            type: false,
        });
    });

    it('uses explicit selectors without adding defaults', () => {
        expect(parseCheckArgs(['--staged', '--type'])).toEqual({
            files: [],
            knip: false,
            lint: false,
            staged: true,
            test: false,
            type: true,
        });
    });

    it('treats --knip as an explicit selector that suppresses defaults', () => {
        expect(parseCheckArgs(['--knip'])).toEqual({
            files: [],
            knip: true,
            lint: false,
            staged: false,
            test: false,
            type: false,
        });
    });
});

describe('lintPipelineForFile', () => {
    it('matches the repository lint-staged pipelines', () => {
        expect(lintPipelineForFile('src/main/index.ts')).toBe('code');
        expect(lintPipelineForFile('DESIGN.md')).toBe('format');
        expect(lintPipelineForFile('assets/font.woff2')).toBeUndefined();
    });
});

describe('testCandidatesForFile', () => {
    it('runs a changed test directly', () => {
        expect(testCandidatesForFile('src/runtime/foo.test.ts')).toEqual([
            'src/runtime/foo.test.ts',
        ]);
    });

    it('discovers sibling and __tests__ layouts for source files', () => {
        expect(testCandidatesForFile('src/runtime/foo.ts')).toContain(
            'src/runtime/__tests__/foo.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/foo.ts')).toContain('src/runtime/foo.test.ts');
    });

    it('does not infer tests for declarations or documentation', () => {
        expect(testCandidatesForFile('src/shared/global.d.ts')).toEqual([]);
        expect(testCandidatesForFile('README.md')).toEqual([]);
    });

    it('discovers a same-stem integration suite alongside a source file', () => {
        expect(testCandidatesForFile('src/runtime/git.ts')).toContain(
            'src/runtime/__tests__/git.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/terminal.ts')).toContain(
            'src/runtime/__tests__/terminal.integration.test.ts',
        );
    });

    it('discovers a domain-named integration suite for a nested subdirectory', () => {
        expect(testCandidatesForFile('src/runtime/db/connection.ts')).toContain(
            'src/runtime/db/__tests__/db.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/db/repository.ts')).toContain(
            'src/runtime/db/__tests__/repository.integration.test.ts',
        );
        expect(testCandidatesForFile('src/runtime/files/search.ts')).toEqual(
            expect.arrayContaining([
                'src/runtime/files/__tests__/search.integration.test.ts',
                'src/runtime/files/__tests__/files.integration.test.ts',
            ]),
        );
    });

    it('does not treat a top-level runtime file as a domain integration suite', () => {
        expect(testCandidatesForFile('src/runtime/bootstrap.ts')).not.toContain(
            'src/runtime/__tests__/runtime.integration.test.ts',
        );
    });
});
