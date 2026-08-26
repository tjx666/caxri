import { describe, expect, it } from 'vitest';

import {
    agentSkillsTestFiles,
    apiTestFiles,
    clientTestFiles,
    cliTestFiles,
    desktopParallelExcludes,
    desktopTestFiles,
    protocolTestFiles,
    resolveVitestPartition,
    testProjectNames,
    utilitiesTestFiles,
    workspaceAliases,
} from '../../vitest.config';

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
    it('discovers skill tests colocated under scripts/__tests__', () => {
        expect(desktopTestFiles).toContain('.agents/skills/**/scripts/__tests__/*.test.ts');
    });

    it('never follows workspace dependencies while adding serial native exclusions', () => {
        expect(desktopParallelExcludes).toEqual(
            expect.arrayContaining(['**/node_modules/**', '**/.git/**']),
        );
    });

    it('owns Desktop and workspace tests in named projects', () => {
        expect(testProjectNames).toEqual([
            'desktop-parallel',
            'desktop-serial-native',
            'agent-skills',
            'protocol',
            'api',
            'client',
            'utils',
            'cli',
        ]);
        expect(agentSkillsTestFiles).toEqual(['packages/agent-skills/{scripts,src}/**/*.test.ts']);
        expect(protocolTestFiles).toEqual(['packages/protocol/src/**/*.test.ts']);
        expect(apiTestFiles).toEqual(['packages/extension-api/src/**/*.test.ts']);
        expect(clientTestFiles).toEqual(['packages/client/src/**/*.test.ts']);
        expect(utilitiesTestFiles).toEqual(['packages/utils/src/**/*.test.ts']);
        expect(cliTestFiles).toEqual(['apps/cli/{scripts,src}/**/*.test.ts']);
        expect(desktopTestFiles).toEqual(
            expect.arrayContaining([
                'apps/desktop/src/**/*.test.ts',
                'apps/server/src/**/*.test.ts',
            ]),
        );
        expect(workspaceAliases.caxri).toBe(
            new URL('../../packages/extension-api/src/index.ts', import.meta.url).pathname,
        );
        expect(workspaceAliases['@caxri/agent-skills/testing']).toBe(
            new URL('../../packages/agent-skills/src/testing.ts', import.meta.url).pathname,
        );
    });

    it('keeps native file watchers serial while allowing isolated file tests to use both workers', () => {
        const partition = resolveVitestPartition({});

        expect(partition.maxWorkers).toBe(2);
        expect(partition.serialNativeTests).toEqual([
            'apps/server/src/runtime/__tests__/agent-hooks.integration.test.ts',
            'apps/server/src/runtime/__tests__/configuration.test.ts',
            'apps/server/src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
            'src/runtime/__tests__/agent-hooks.integration.test.ts',
            'src/runtime/__tests__/configuration.test.ts',
            'src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
            'src/runtime/files/__tests__/files.integration.test.ts',
            'apps/server/src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/git/__tests__/git.integration.test.ts',
            'apps/server/src/runtime/git/__tests__/git.integration.test.ts',
        ]);
        expect(partition.serialNativeTests).not.toEqual(expect.arrayContaining(SAFE_FILE_TESTS));
    });

    it('keeps the legacy control profile intact and permits bounded worker comparisons', () => {
        expect(
            resolveVitestPartition({ CAXRI_VITEST_PARTITION: 'legacy' }).serialNativeTests,
        ).toEqual(
            expect.arrayContaining([
                'src/runtime/files/__tests__/*.test.ts',
                'apps/server/src/runtime/files/__tests__/*.test.ts',
            ]),
        );
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
