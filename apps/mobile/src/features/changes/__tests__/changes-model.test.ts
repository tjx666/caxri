import { describe, expect, it } from 'vitest';

import {
    changePathParts,
    changesSummary,
    hasMultipleRepositories,
    parseUnifiedDiff,
} from '../changes-model';

describe('parseUnifiedDiff', () => {
    it('counts lines and advances both sides across hunks', () => {
        const parsed = parseUnifiedDiff(
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more\n\\ No newline at end of file\n@@ -10 +11 @@\n-end\n+start\n',
        );
        expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({
            additions: 3,
            deletions: 2,
        });
        expect(parsed.lines.filter((line) => line.kind === 'added')).toMatchObject([
            { kind: 'added', content: 'new', oldLine: null, newLine: 4, marker: '+' },
            { kind: 'added', content: 'more', oldLine: null, newLine: 5, marker: '+' },
            { kind: 'added', content: 'start', oldLine: null, newLine: 11, marker: '+' },
        ]);
        expect(parsed.lines.find((line) => line.kind === 'removed')).toMatchObject({
            kind: 'removed',
            content: 'old',
            oldLine: 4,
            newLine: null,
            marker: '−',
        });
        expect(parsed.lines.find((line) => line.kind === 'meta')?.content).toBe(
            String.raw`\ No newline at end of file`,
        );
    });

    it('does not count file headers or metadata as changed lines', () => {
        const parsed = parseUnifiedDiff('--- a/a\n+++ b/a\nBinary files a/a and b/a differ\n');
        expect(parsed.additions).toBe(0);
        expect(parsed.deletions).toBe(0);
    });
});

it('formats a path and summary for file rows', () => {
    expect(changePathParts('src/sub/file.ts')).toEqual({
        directory: 'src/sub/',
        filename: 'file.ts',
    });
    expect(changesSummary(1, 2, 0)).toBe('1 file changed · +2 −0');
});

it('shows repository names when paths can be ambiguous across repositories', () => {
    const file = {
        repositoryId: 'repo-one',
        repositoryName: 'website',
        path: 'src/index.ts',
        status: 'M' as const,
        additions: 1,
        deletions: 0,
    };
    expect(hasMultipleRepositories([file, { ...file, path: 'src/other.ts' }])).toBe(false);
    expect(
        hasMultipleRepositories([
            file,
            { ...file, repositoryId: 'repo-two', repositoryName: 'backend' },
        ]),
    ).toBe(true);
});
