import { describe, expect, it } from 'vitest';

import { sessionChildGuidePaths } from '../session-child-guide-paths';

describe('sessionChildGuidePaths', () => {
    it('draws one arc per branch row from the host icon to the child glyph, ending the trunk in the last arc', () => {
        const guide = sessionChildGuidePaths({
            continuesBelow: false,
            rows: ['branch', 'branch'],
        });
        expect(guide.height).toBe(48);
        expect(guide.paths).toEqual(['M15 -4 V4 Q15 12 23 12 H31', 'M15 -4 V28 Q15 36 23 36 H31']);
        expect(guide.selectedPath).toBeUndefined();
    });

    it('gives a reveal row no branch and runs no trunk past the last branch', () => {
        const guide = sessionChildGuidePaths({
            continuesBelow: false,
            rows: ['branch', 'pass'],
        });
        expect(guide.paths).toEqual(['M15 -4 V4 Q15 12 23 12 H31']);
    });

    it('keeps branching past a toggle row in the middle of the list', () => {
        const guide = sessionChildGuidePaths({
            continuesBelow: false,
            rows: ['branch', 'pass', 'branch'],
        });
        expect(guide.paths).toEqual(['M15 -4 V4 Q15 12 23 12 H31', 'M15 -4 V52 Q15 60 23 60 H31']);
    });

    it('stops a continued trunk where the next list starts its own, so the line never overlaps', () => {
        const guide = sessionChildGuidePaths({
            continuesBelow: true,
            rows: ['branch', 'pass'],
        });
        expect(guide.paths).toContain('M15 -4 V44');
    });

    it('lights the path to the selected branch row only', () => {
        expect(
            sessionChildGuidePaths({
                continuesBelow: false,
                rows: ['branch', 'branch'],
                selectedIndex: 1,
            }).selectedPath,
        ).toBe('M15 -4 V28 Q15 36 23 36 H31');
        expect(
            sessionChildGuidePaths({
                continuesBelow: false,
                rows: ['branch', 'pass'],
                selectedIndex: 1,
            }).selectedPath,
        ).toBeUndefined();
    });

    it('lights the whole continued trunk when the selected child sits in a later list', () => {
        const guide = sessionChildGuidePaths({
            continuesBelow: true,
            rows: ['branch'],
            selectedBelow: true,
            selectedIndex: 0,
        });
        expect(guide.selectedPath).toBe('M15 -4 V20');
    });

    it('draws nothing for a list of reveal rows alone', () => {
        expect(sessionChildGuidePaths({ continuesBelow: false, rows: ['pass'] }).paths).toEqual([]);
    });
});
