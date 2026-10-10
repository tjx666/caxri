import { describe, expect, it } from 'vitest';

import type { ChipVisibility } from '../chip-priority';
import { CHIP_PRIORITY_BREAKPOINTS, resolveChipVisibility } from '../chip-priority';

const ALL_VISIBLE: ChipVisibility = {
    acceptance: true,
    agentThroughput: true,
    childProcessCount: true,
    linearIssue: true,
    memory: true,
    pullRequest: true,
};

describe('status bar chip priority resolution', () => {
    it('shows every chip at ample width', () => {
        expect(resolveChipVisibility(1200)).toEqual(ALL_VISIBLE);
    });

    it('treats an unmeasured (zero or negative) width as fully visible', () => {
        expect(resolveChipVisibility(0)).toEqual(ALL_VISIBLE);
        expect(resolveChipVisibility(-1)).toEqual(ALL_VISIBLE);
    });

    it('drops the child-process count chip first', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.childProcessCount - 1;
        expect(resolveChipVisibility(width)).toEqual({
            ...ALL_VISIBLE,
            childProcessCount: false,
        });
    });

    it('drops memory next, after child-process count is already hidden', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.memory - 1;
        expect(resolveChipVisibility(width)).toEqual({
            ...ALL_VISIBLE,
            childProcessCount: false,
            memory: false,
        });
    });

    it('drops the Agent output speed after memory', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.agentThroughput - 1;
        expect(resolveChipVisibility(width)).toEqual({
            ...ALL_VISIBLE,
            agentThroughput: false,
            childProcessCount: false,
            memory: false,
        });
    });

    it('drops the Linear issue chip before the acceptance chip', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.linearIssue - 1;
        expect(resolveChipVisibility(width)).toEqual({
            acceptance: true,
            agentThroughput: false,
            childProcessCount: false,
            linearIssue: false,
            memory: false,
            pullRequest: true,
        });
    });

    it('drops the acceptance chip before the pull request chip', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.acceptance - 1;
        expect(resolveChipVisibility(width)).toEqual({
            acceptance: false,
            agentThroughput: false,
            childProcessCount: false,
            linearIssue: false,
            memory: false,
            pullRequest: true,
        });
    });

    it('drops the pull request chip last of the six', () => {
        const width = CHIP_PRIORITY_BREAKPOINTS.pullRequest - 1;
        expect(resolveChipVisibility(width)).toEqual({
            acceptance: false,
            agentThroughput: false,
            childProcessCount: false,
            linearIssue: false,
            memory: false,
            pullRequest: false,
        });
    });

    it('is monotonic: a narrower width never re-shows a chip a wider width hid', () => {
        // Excludes the `<= 0` "unmeasured" sentinel, which is a special case (fully visible), not part
        // of a real monotonically decreasing width sequence.
        const widths = [
            1200, 900, 830, 800, 760, 752, 700, 680, 620, 610, 560, 545, 500, 480, 400, 1,
        ];
        let previous: ChipVisibility | undefined;
        for (const width of widths) {
            const current = resolveChipVisibility(width);
            if (previous)
                for (const chip of Object.keys(current) as Array<keyof ChipVisibility>)
                    if (previous[chip] === false) expect(current[chip]).toBe(false);
            previous = current;
        }
    });
});
