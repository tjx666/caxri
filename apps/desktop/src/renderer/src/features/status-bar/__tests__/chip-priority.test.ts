import { describe, expect, it } from 'vitest';

import { CHIP_PRIORITY_BREAKPOINTS, resolveChipVisibility } from '../chip-priority';

describe('status bar chip priority resolution', () => {
    it('shows every chip at ample width', () => {
        expect(resolveChipVisibility(1200)).toEqual({
            childProcessCount: true,
            linearIssue: true,
            memory: true,
            pullRequest: true,
        });
    });

    it('treats an unmeasured (zero or negative) width as fully visible', () => {
        expect(resolveChipVisibility(0)).toEqual({
            childProcessCount: true,
            linearIssue: true,
            memory: true,
            pullRequest: true,
        });
        expect(resolveChipVisibility(-1)).toEqual({
            childProcessCount: true,
            linearIssue: true,
            memory: true,
            pullRequest: true,
        });
    });

    it('drops the child-process count chip first', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.childProcessCount - 1;
        expect(resolveChipVisibility(width)).toEqual({
            childProcessCount: false,
            linearIssue: true,
            memory: true,
            pullRequest: true,
        });
    });

    it('drops memory next, after child-process count is already hidden', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.memory - 1;
        expect(resolveChipVisibility(width)).toEqual({
            childProcessCount: false,
            linearIssue: true,
            memory: false,
            pullRequest: true,
        });
    });

    it('drops the Linear issue chip before the pull request chip', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.linearIssue - 1;
        expect(resolveChipVisibility(width)).toEqual({
            childProcessCount: false,
            linearIssue: false,
            memory: false,
            pullRequest: true,
        });
    });

    it('drops the pull request chip last of the four', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.pullRequest - 1;
        expect(resolveChipVisibility(width)).toEqual({
            childProcessCount: false,
            linearIssue: false,
            memory: false,
            pullRequest: false,
        });
    });

    it('is monotonic: a narrower width never re-shows a chip a wider width hid', () => {
        // Excludes the `<= 0` "unmeasured" sentinel, which is a special case (fully visible), not part
        // of a real monotonically decreasing width sequence.
        const widths = [1200, 900, 760, 752, 700, 680, 620, 610, 560, 545, 400, 1];
        let previous: ReturnType<typeof resolveChipVisibility> | undefined;
        for (const width of widths) {
            const current = resolveChipVisibility(width);
            if (previous) {
                if (previous.childProcessCount === false)
                    expect(current.childProcessCount).toBe(false);
                if (previous.linearIssue === false) expect(current.linearIssue).toBe(false);
                if (previous.memory === false) expect(current.memory).toBe(false);
                if (previous.pullRequest === false) expect(current.pullRequest).toBe(false);
            }
            previous = current;
        }
    });
});
