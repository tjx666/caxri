import type { GitCommitDetails } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildSourceControlHistoryDetails } from '../source-control-history';

describe('Git Source Control history projection', () => {
    it('keeps a long commit resource path out of the bounded resource identity', () => {
        const path = `${'history/'.repeat(2_000)}file.ts`;
        const details: GitCommitDetails = {
            commit: {
                sha: '0123456789abcdef0123456789abcdef01234567',
                shortSha: '0123456',
                subject: 'Long path',
                body: '',
                author: 'Caxri',
                authorEmail: 'caxri@example.com',
                authoredAt: 1_700_000_000_000,
                decorations: [],
                parents: [],
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
});
