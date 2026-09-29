import './host-api.fixture';

import type { GitCommitDetails, GitSummary } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildSourceControlViewModel } from '../source-control-model';

const head = '0123456789abcdef0123456789abcdef01234567';

function summaryWith(files: GitSummary['repositories'][number]['files']): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo-1',
                kind: 'primary',
                name: 'project',
                rootPath: '/authorized/project',
                branch: 'main',
                head,
                ahead: 0,
                behind: 0,
                additions: 3,
                deletions: 4,
                generation: 1,
                changedFileCount: files.length,
                truncated: false,
                files,
            },
        ],
    };
}

describe('Git Source Control line counts', () => {
    it('publishes measured working-tree line counts and omits unmeasured ones', () => {
        const summary = summaryWith([
            {
                path: 'src/extension.ts',
                index: ' ',
                workingTree: 'M',
                kind: 'modified',
                additions: 3,
                deletions: 4,
            },
            { path: 'huge.bin', index: '?', workingTree: '?', kind: 'untracked' },
        ]);
        const resources = buildSourceControlViewModel({ mode: 'working', summary }).providers[0]
            .groups[0].resources;
        const byPath = new Map(resources.map((resource) => [resource.path, resource]));
        expect(byPath.get('src/extension.ts')?.lineStats).toEqual({ additions: 3, deletions: 4 });
        expect(byPath.get('huge.bin')).not.toHaveProperty('lineStats');
    });

    it('carries a commit file line counts into Last Commit resources', () => {
        const details: GitCommitDetails = {
            commit: {
                sha: head,
                shortSha: '0123456',
                subject: 'Rename',
                body: '',
                author: 'Octocat',
                authorEmail: 'octocat@users.noreply.github.com',
                authoredAt: 1_700_000_000_000,
                decorations: [],
                parents: [],
            },
            additions: 2,
            deletions: 1,
            files: [
                {
                    path: 'src/new-name.ts',
                    previousPath: 'src/old-name.ts',
                    status: 'renamed',
                    additions: 2,
                    deletions: 1,
                },
            ],
            filesTruncated: false,
        };
        const model = buildSourceControlViewModel({
            mode: 'commit',
            summary: summaryWith([]),
            detailsByRepository: new Map([['repo-1', details]]),
        });
        expect(model.providers[0].groups[0].resources[0].lineStats).toEqual({
            additions: 2,
            deletions: 1,
        });
    });
});
