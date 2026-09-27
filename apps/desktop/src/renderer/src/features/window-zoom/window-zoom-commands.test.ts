import { describe, expect, it } from 'vitest';

import { nextWindowZoomLevel } from './window-zoom-commands';

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
