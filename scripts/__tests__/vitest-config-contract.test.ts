import { describe, expect, it } from 'vitest';

import { resolveVitestPartition } from '../../vitest.config';

const SAFE_FILE_TESTS = [
    'src/runtime/files/__tests__/file-tree-excludes.test.ts',
    'src/runtime/files/__tests__/operation-queue.test.ts',
    'src/runtime/files/__tests__/documents.test.ts',
    'src/runtime/files/__tests__/mutation-journal.test.ts',
    'src/runtime/files/__tests__/mutations.integration.test.ts',
    'src/runtime/files/__tests__/mutations-move-replace.integration.test.ts',
    'src/runtime/files/__tests__/search.integration.test.ts',
    'src/runtime/files/__tests__/git-ignore.integration.test.ts',
];

describe('Vitest project partition', () => {
    it('keeps native file watchers serial while allowing isolated file tests to use both workers', () => {
        const partition = resolveVitestPartition({});

        expect(partition.maxWorkers).toBe(2);
        expect(partition.serialNativeTests).toEqual([
            'src/runtime/__tests__/agent-hooks.integration.test.ts',
            'src/runtime/__tests__/configuration.test.ts',
            'src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
            'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/git/__tests__/git.integration.test.ts',
        ]);
        expect(partition.serialNativeTests).not.toEqual(expect.arrayContaining(SAFE_FILE_TESTS));
    });

    it('keeps the legacy control profile intact and permits bounded worker comparisons', () => {
        expect(
            resolveVitestPartition({ CAXRI_VITEST_PARTITION: 'legacy' }).serialNativeTests,
        ).toEqual(expect.arrayContaining(['src/runtime/files/__tests__/*.test.ts']));
        expect(resolveVitestPartition({ CAXRI_VITEST_MAX_WORKERS: '1' }).maxWorkers).toBe(1);
        expect(resolveVitestPartition({ CAXRI_VITEST_MAX_WORKERS: '4' }).maxWorkers).toBe(4);
    });

    it('fails closed for unsupported partition and worker values', () => {
        expect(() => resolveVitestPartition({ CAXRI_VITEST_PARTITION: 'parallel' })).toThrow(
            'CAXRI_VITEST_PARTITION must be legacy or optimized',
        );
        expect(() => resolveVitestPartition({ CAXRI_VITEST_MAX_WORKERS: '5' })).toThrow(
            'CAXRI_VITEST_MAX_WORKERS must be 1, 2, 3, or 4',
        );
    });
});
