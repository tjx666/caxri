import { describe, expect, it } from 'vitest';

import {
    mobileLayoutMode,
    TABLET_MIN_SHORT_SIDE,
    TABLET_SPLIT_WIDTH,
    WIDE_TABLET_WIDTH,
} from '../layout-mode';

describe('mobileLayoutMode', () => {
    it('keeps portrait and landscape phones in the single-pane flow', () => {
        expect(mobileLayoutMode(390, 844)).toBe('phone');
        expect(mobileLayoutMode(TABLET_SPLIT_WIDTH - 1, 900)).toBe('phone');
        expect(mobileLayoutMode(844, TABLET_MIN_SHORT_SIDE - 1)).toBe('phone');
    });

    it('uses two panes only when width and short side reach the tablet thresholds', () => {
        expect(mobileLayoutMode(TABLET_SPLIT_WIDTH, TABLET_MIN_SHORT_SIDE)).toBe('tablet-split');
        expect(mobileLayoutMode(800, 1_280)).toBe('tablet-split');
        expect(mobileLayoutMode(1_000, 700)).toBe('tablet-split');
    });

    it('adds a Changes pane on wide tablets and responds to fold size changes', () => {
        expect(mobileLayoutMode(WIDE_TABLET_WIDTH, 700)).toBe('tablet-wide');
        expect(mobileLayoutMode(1_280, 800)).toBe('tablet-wide');
        expect(mobileLayoutMode(900, 700)).toBe('tablet-split');
        expect(mobileLayoutMode(430, 900)).toBe('phone');
    });
});
