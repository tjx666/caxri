import './host-api.fixture';

import type { GitCommitDetails, GitCommitPage, SourceControlAction } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import {
    buildSourceControlHistoryDetails,
    buildSourceControlHistoryPage,
} from '../source-control-history';
import type { ActionRegistration } from '../source-control-model';

const commit = {
    sha: '0123456789abcdef0123456789abcdef01234567',
    shortSha: '0123456',
    subject: 'Add file history',
    body: '',
    author: 'Caxri',
    authorEmail: 'caxri@example.com',
    authoredAt: 1_700_000_000_000,
    decorations: [],
    parents: [],
};

const page: GitCommitPage = { commits: [commit] };

describe('Git Source Control history projection', () => {
    it('preserves a structured hidden count when every committed file is excluded', () => {
        const result = buildSourceControlHistoryDetails({
            details: {
                commit,
                files: [{ path: 'src/example.test.ts', status: 'modified' }],
                filesTruncated: false,
                additions: 1,
                deletions: 1,
            },
            excludePatterns: { '**/*.test.*': true },
            registerAction: (action) => ({ id: 'action-1', ...action }),
            repositoryId: 'repo',
            revision: '1',
        });
        expect(result).toMatchObject({
            resources: [],
            hiddenCount: 1,
            summary: '1 file changed · 1 hidden',
        });
    });

    it('registers an open-changes action for file-scoped history items', () => {
        const registerAction = vi.fn((action: ActionRegistration): SourceControlAction => ({
            id: 'action-1',
            ...action,
        }));

        const result = buildSourceControlHistoryPage(page, '1', null, {
            path: 'src/feature file.ts',
            registerAction,
            repositoryId: 'repo/nested',
        });

        expect(result.items[0]?.action).toMatchObject({
            command: {
                id: 'caxri.git.openChanges',
                arguments: [
                    'caxri-git-diff://commit-file/repo%2Fnested/0123456789abcdef0123456789abcdef01234567/src%2Ffeature%20file.ts',
                ],
            },
            icon: { kind: 'theme', id: 'diff' },
            id: 'action-1',
            label: 'Open changes in src/feature file.ts',
        });
        expect(registerAction).toHaveBeenCalledOnce();
    });

    it('keeps repository history items passive and omits oversized file actions', () => {
        const registerAction = vi.fn((action: ActionRegistration): SourceControlAction => ({
            id: 'action-1',
            ...action,
        }));

        const repoHistory = buildSourceControlHistoryPage(page, '1');
        const oversizedFileHistory = buildSourceControlHistoryPage(page, '1', null, {
            path: `${'history/'.repeat(2_000)}file.ts`,
            registerAction,
            repositoryId: 'repo-1',
        });

        expect(repoHistory.items[0]?.action).toBeUndefined();
        expect(oversizedFileHistory.items[0]?.action).toBeUndefined();
        expect(registerAction).not.toHaveBeenCalled();
    });

    it('keeps a long commit resource path out of the bounded resource identity', () => {
        const path = `${'history/'.repeat(2_000)}file.ts`;
        const details: GitCommitDetails = {
            commit: {
                ...commit,
                subject: 'Long path',
            },
            additions: 1,
            deletions: 0,
            files: [{ path, status: 'modified' }],
            filesTruncated: false,
        };

        const result = buildSourceControlHistoryDetails({
            details,
            registerAction: (action) => ({ id: 'action-1', ...action }),
            repositoryId: 'repo-1',
            revision: '1',
        });

        expect(result.resources[0].id.length).toBeLessThanOrEqual(480);
        expect(result.resources[0].path.length).toBeLessThanOrEqual(4_096);
        expect(result.resources[0].tooltip.length).toBeLessThanOrEqual(4_096);
        expect(result.resources[0].accessibilityLabel.length).toBeLessThanOrEqual(1_024);
        expect(result.resources[0].editorResource).toBeUndefined();
        expect(result.resources[0].action).toBeUndefined();
    });

    it('filters repository commit details and keeps the raw changed-file summary', () => {
        const details: GitCommitDetails = {
            commit,
            additions: 2,
            deletions: 0,
            files: [
                { path: 'src/feature.ts', status: 'modified' },
                { path: 'src/feature.test.ts', status: 'modified' },
            ],
            filesTruncated: false,
        };

        const result = buildSourceControlHistoryDetails({
            details,
            excludePatterns: { '**/*.test.*': true },
            registerAction: (action) => ({ id: 'action-1', ...action }),
            repositoryId: 'repo-1',
            revision: '1',
        });

        expect(result.summary).toBe('2 files changed · 1 hidden');
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].label).toBe('feature.ts');
    });
});
