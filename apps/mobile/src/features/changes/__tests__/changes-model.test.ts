import { describe, expect, it } from 'vitest';

import {
    changedFilesSummary,
    changePathParts,
    changesSummaryLabel,
    diffLineNumber,
    diffLineNumberDigits,
    hasMultipleRepositories,
    parseUnifiedDiff,
    visibleDiffLines,
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
    expect(changedFilesSummary(1)).toBe('1 file changed');
    expect(changedFilesSummary(3)).toBe('3 files changed');
    expect(changesSummaryLabel(3, 1_940, 684)).toBe(
        '3 files changed, 1940 lines added, 684 removed',
    );
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

describe('visibleDiffLines', () => {
    it('drops the Git preamble once the patch has a hunk', () => {
        const { lines } = parseUnifiedDiff(
            'diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n',
        );
        expect(visibleDiffLines(lines).map((line) => line.kind)).toEqual([
            'hunk',
            'removed',
            'added',
        ]);
    });

    it('keeps the preamble when it is the whole message', () => {
        const { lines } = parseUnifiedDiff('--- a/a\n+++ b/a\nBinary files a/a and b/a differ\n');
        expect(visibleDiffLines(lines)).toEqual(lines);
    });
});

describe('diff line numbers', () => {
    it('shows the new line, or the old one for a removed line', () => {
        expect(diffLineNumber({ oldLine: 4, newLine: 5 })).toBe(5);
        expect(diffLineNumber({ oldLine: 4, newLine: null })).toBe(4);
        expect(diffLineNumber({ oldLine: null, newLine: null })).toBeNull();
    });

    it('sizes the gutter to the largest number, never below two digits', () => {
        expect(diffLineNumberDigits([])).toBe(2);
        expect(diffLineNumberDigits([{ oldLine: 7, newLine: null }])).toBe(2);
        expect(
            diffLineNumberDigits([
                { oldLine: 998, newLine: 1_002 },
                { oldLine: null, newLine: null },
            ]),
        ).toBe(4);
    });
});
