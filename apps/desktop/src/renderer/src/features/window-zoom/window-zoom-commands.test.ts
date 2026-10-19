import { describe, expect, it } from 'vitest';

import { nextWindowZoomLevel, windowZoomPercent } from './window-zoom-commands';

describe('nextWindowZoomLevel', () => {
    it('steps by one level within the setting bounds', () => {
        expect(nextWindowZoomLevel(0, 'in')).toBe(1);
        expect(nextWindowZoomLevel(0, 'out')).toBe(-1);
        expect(nextWindowZoomLevel(8, 'in')).toBe(8);
        expect(nextWindowZoomLevel(-5, 'out')).toBe(-5);
    });

    it('resets by removing the key so settings.jsonc keeps only explicit choices', () => {
        expect(nextWindowZoomLevel(3, 'reset')).toBeUndefined();
    });
});

describe('windowZoomPercent', () => {
    it('shows the Chromium page scale of a level as a whole percent', () => {
        expect(windowZoomPercent(0)).toBe(100);
        expect(windowZoomPercent(1)).toBe(120);
        expect(windowZoomPercent(-1)).toBe(83);
        expect(windowZoomPercent(2)).toBe(144);
    });
});
