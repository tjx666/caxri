import { describe, expect, it } from 'vitest';

import { mobileLayoutMode, TABLET_SPLIT_WIDTH } from '../layout-mode';

describe('mobileLayoutMode', () => {
    it('keeps narrow and boundary-adjacent widths in the intended layout', () => {
        expect(mobileLayoutMode(390)).toBe('phone');
        expect(mobileLayoutMode(TABLET_SPLIT_WIDTH - 1)).toBe('phone');
        expect(mobileLayoutMode(TABLET_SPLIT_WIDTH)).toBe('tablet-split');
        expect(mobileLayoutMode(1_600)).toBe('tablet-split');
    });
});
