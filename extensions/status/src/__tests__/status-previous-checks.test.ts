import type { ProjectStatusPreviousChecks } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    changedFilesDescription,
    isDocumentationPath,
    previousChecksNode,
} from '../status-previous-checks';

const previous: ProjectStatusPreviousChecks = {
    title: 'fix(router): handle empty input',
    state: 'success',
    commitsBefore: 1,
    url: 'https://github.com/acme/widget/pull/7/commits/abc',
    changedFiles: [
        { path: 'docs/guide.md', additions: 3, deletions: 1 },
        { path: 'README.md', additions: 1, deletions: 0 },
    ],
};

describe('isDocumentationPath', () => {
    it('treats prose files and images under docs/ as documentation', () => {
        expect(isDocumentationPath('README.md')).toBe(true);
        expect(isDocumentationPath('packages/a/CHANGELOG.mdx')).toBe(true);
        expect(isDocumentationPath('docs/images/flow.png')).toBe(true);
        expect(isDocumentationPath('src/assets/logo.png')).toBe(false);
        expect(isDocumentationPath('src/docs-loader.ts')).toBe(false);
        expect(isDocumentationPath('requirements.txt')).toBe(false);
        expect(isDocumentationPath('docs/site.config.ts')).toBe(false);
        expect(isDocumentationPath('src/index.ts')).toBe(false);
    });
});

describe('changedFilesDescription', () => {
    it('says docs only when every file is documentation, otherwise the line delta', () => {
        expect(changedFilesDescription(previous.changedFiles!)).toBe('docs only');
        expect(
            changedFilesDescription([
                ...previous.changedFiles!,
                { path: 'src/index.ts', additions: 5, deletions: 2 },
            ]),
        ).toBe('+9 −3');
    });

    it('never claims docs only for a list GitHub may have truncated', () => {
        const files = Array.from({ length: 300 }, (_, index) => ({
            path: `docs/page-${index}.md`,
            additions: 1,
            deletions: 0,
        }));

        expect(changedFilesDescription(files)).toBe('+300 −0');
    });
});

describe('previousChecksNode', () => {
    it('names the commit by its title and nests the files changed since', () => {
        const node = previousChecksNode('p', previous);

        expect(node.item.label).toBe('Previous commit: fix(router): handle empty input');
        expect(node.item.description).toBe('previous');
        expect(node.item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
        const files = node.children?.[0];
        expect(files?.item.label).toBe('2 files changed since');
        expect(files?.item.description).toBe('docs only');
        expect(files?.children?.map((child) => [child.item.label, child.item.description])).toEqual(
            [
                ['guide.md', '+3 −1'],
                ['README.md', '+1 −0'],
            ],
        );
    });

    it('shows only the verdict when the comparison was not read', () => {
        const node = previousChecksNode('p', {
            ...previous,
            state: 'failure',
            commitsBefore: 3,
            changedFiles: undefined,
        });

        expect(node.item.description).toBe('3 commits back');
        expect(node.children).toEqual([]);
        expect(node.item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    });
});
