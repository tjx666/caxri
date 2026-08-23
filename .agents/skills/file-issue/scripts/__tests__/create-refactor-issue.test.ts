import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { RefactorIssueCreateDependencies } from '../create-refactor-issue';
import { createRefactorIssue } from '../create-refactor-issue';

const options = {
    bodyFile: '/draft/refactor.md',
    labels: ['enhancement', 'skill'],
    repo: 'tjx666/caxri',
    title: '强化重构验收契约',
};

function dependencies(body: string): RefactorIssueCreateDependencies {
    return {
        makeTemporaryDirectory: vi.fn(() => Promise.resolve('/tmp/caxri-refactor-issue-test')),
        readBody: vi.fn(() => Promise.resolve(body)),
        removeTemporaryDirectory: vi.fn(() => Promise.resolve()),
        reportCleanupFailure: vi.fn(),
        runGitHub: vi.fn(() => Promise.resolve('https://github.com/tjx666/caxri/issues/999\n')),
        temporaryRoot: '/tmp',
        writeSnapshot: vi.fn(() => Promise.resolve()),
    };
}

describe('createRefactorIssue', () => {
    it('creates the issue from the immutable snapshot that passed validation', async () => {
        const body = await readFile(
            new URL('../__fixtures__/refactor-acceptance/complete-visual.md', import.meta.url),
            'utf8',
        );
        const harness = dependencies(body);

        await expect(createRefactorIssue(options, harness)).resolves.toBe(
            'https://github.com/tjx666/caxri/issues/999',
        );
        expect(harness.writeSnapshot).toHaveBeenCalledWith(
            '/tmp/caxri-refactor-issue-test/body.md',
            body,
        );
        expect(harness.runGitHub).toHaveBeenCalledWith([
            'issue',
            'create',
            '--repo',
            'tjx666/caxri',
            '--title',
            '强化重构验收契约',
            '--body-file',
            '/tmp/caxri-refactor-issue-test/body.md',
            '--label',
            'enhancement',
            '--label',
            'skill',
        ]);
        expect(harness.removeTemporaryDirectory).toHaveBeenCalledWith(
            '/tmp/caxri-refactor-issue-test',
        );
    });

    it('does not call GitHub when the body fails the parity contract', async () => {
        const body = await readFile(
            new URL('../__fixtures__/refactor-acceptance/only-new-screenshot.md', import.meta.url),
            'utf8',
        );
        const harness = dependencies(body);

        await expect(createRefactorIssue(options, harness)).rejects.toThrow(
            '前后基线必须同时说明重构前和重构后',
        );
        expect(harness.makeTemporaryDirectory).not.toHaveBeenCalled();
        expect(harness.runGitHub).not.toHaveBeenCalled();
    });

    it('returns the created issue URL when best-effort cleanup fails', async () => {
        const body = await readFile(
            new URL('../__fixtures__/refactor-acceptance/complete-visual.md', import.meta.url),
            'utf8',
        );
        const harness = dependencies(body);
        vi.mocked(harness.removeTemporaryDirectory).mockRejectedValueOnce(
            new Error('cleanup failed'),
        );

        await expect(createRefactorIssue(options, harness)).resolves.toBe(
            'https://github.com/tjx666/caxri/issues/999',
        );
        expect(harness.reportCleanupFailure).toHaveBeenCalledOnce();
    });
});
