import { describe, expect, it } from 'vitest';

import { parseGitNumstat, sumGitLineStats, withGitLineStat } from '../numstat';

describe('Git numstat', () => {
    it('parses NUL-delimited line counts, skipping binary records and following rename records', () => {
        const stats = parseGitNumstat(
            '2\t1\tmodified.txt\u{0}-\t-\tbinary.bin\u{0}4\t3\t\u{0}old name.txt\u{0}new\nname.txt\u{0}',
        );
        expect([...stats]).toEqual([
            ['modified.txt', { additions: 2, deletions: 1 }],
            ['new\nname.txt', { additions: 4, deletions: 3 }],
        ]);
        expect(sumGitLineStats(stats.values())).toEqual({ additions: 6, deletions: 4 });
    });

    it('folds a no-renames diff of the old path into the renamed file', () => {
        const stats = parseGitNumstat('0\t7\told.txt\u{0}9\t0\tnew.txt\0');
        expect(withGitLineStat({ path: 'new.txt', originalPath: 'old.txt' }, stats)).toEqual({
            path: 'new.txt',
            originalPath: 'old.txt',
            additions: 9,
            deletions: 7,
        });
        expect(withGitLineStat({ path: 'unmeasured.txt' }, stats)).toEqual({
            path: 'unmeasured.txt',
        });
    });
});
