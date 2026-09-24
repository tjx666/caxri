import { describe, expect, it } from 'vitest';

import { isPreviewAtBottom } from '../session-preview-scroll';

describe('Terminal preview scroll position', () => {
    it('follows output only while the reader remains at the bottom', () => {
        expect(isPreviewAtBottom(400, 200, 600)).toBe(true);
        expect(isPreviewAtBottom(376, 200, 600)).toBe(true);
        expect(isPreviewAtBottom(375, 200, 600)).toBe(false);
        expect(isPreviewAtBottom(0, 200, 100)).toBe(true);
    });
});
