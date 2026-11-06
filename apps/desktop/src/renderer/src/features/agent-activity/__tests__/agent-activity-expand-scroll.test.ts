import { describe, expect, it } from 'vitest';

import { expandedAgentActivityGroupScrollTop } from '../agent-activity-expand-scroll';

describe('expandedAgentActivityGroupScrollTop', () => {
    const viewport = { scrollTop: 0, viewportHeight: 400 };

    it('stays put when the opened group is already fully visible', () => {
        expect(
            expandedAgentActivityGroupScrollTop({ ...viewport, groupBottom: 380, groupTop: 200 }),
        ).toBeUndefined();
    });

    it('scrolls just far enough to show the last row of a group opened near the bottom', () => {
        expect(
            expandedAgentActivityGroupScrollTop({ ...viewport, groupBottom: 500, groupTop: 300 }),
        ).toBe(100);
    });

    it('pins the heading to the top when the group is taller than the viewport', () => {
        expect(
            expandedAgentActivityGroupScrollTop({ ...viewport, groupBottom: 1200, groupTop: 350 }),
        ).toBe(350);
    });

    it('never scrolls the list backwards', () => {
        expect(
            expandedAgentActivityGroupScrollTop({
                groupBottom: 900,
                groupTop: 100,
                scrollTop: 200,
                viewportHeight: 400,
            }),
        ).toBeUndefined();
    });
});
