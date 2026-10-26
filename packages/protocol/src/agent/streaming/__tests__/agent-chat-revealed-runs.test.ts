import { describe, expect, it } from 'vitest';

import {
    initialRevealedRuns,
    nextRevealedRuns,
    revealedRunRanges,
} from '../agent-chat-revealed-runs.js';

describe('revealed runs', () => {
    it('shows the text a reply mounted with at once and fades in each later run', () => {
        let runs = initialRevealedRuns('Hello', 1_000, 1_000);
        expect(revealedRunRanges(runs)).toEqual([]);
        runs = nextRevealedRuns(runs, 'Hello, wo');
        runs = nextRevealedRuns(runs, 'Hello, world');
        expect(runs.settledEnd).toBe(5);
        expect(revealedRunRanges(runs)).toEqual([
            [5, 9],
            [9, 12],
        ]);
    });

    it('fades in the first run of a text node that mounts after the reply started', () => {
        const runs = nextRevealedRuns(initialRevealedRuns('New', 2_000, 1_000), 'New line');
        expect(revealedRunRanges(runs)).toEqual([
            [0, 3],
            [3, 8],
        ]);
    });

    it('keeps the same runs for an unchanged text and settles text that no longer extends them', () => {
        const runs = nextRevealedRuns(initialRevealedRuns('ab', 5_000, 0), 'abc');
        expect(nextRevealedRuns(runs, 'abc')).toBe(runs);
        const moved = nextRevealedRuns(runs, 'xyz');
        expect(moved.settledEnd).toBe(3);
        expect(revealedRunRanges(moved)).toEqual([]);
    });

    it('settles the oldest runs so a long stream keeps a bounded number of spans', () => {
        let runs = initialRevealedRuns('', 0, 0);
        for (let length = 1; length <= 100; length += 1)
            runs = nextRevealedRuns(runs, 'x'.repeat(length));
        const ranges = revealedRunRanges(runs);
        expect(ranges).toHaveLength(90);
        expect(ranges[0]).toEqual([10, 11]);
        expect(runs.settledEnd).toBe(10);
    });

    it('settles past a smaller cap for a client that redraws less often', () => {
        let runs = initialRevealedRuns('', 0, 0);
        for (let length = 1; length <= 30; length += 1)
            runs = nextRevealedRuns(runs, 'x'.repeat(length), 24);
        expect(revealedRunRanges(runs)).toHaveLength(24);
        expect(runs.settledEnd).toBe(6);
    });
});
