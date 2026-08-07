import { describe, expect, it } from 'vitest';

import {
    clampLayoutToViewport,
    clampWidth,
    INSPECTOR_DEFAULT_WIDTH,
    INSPECTOR_MIN_WIDTH,
    MIN_MAIN_WIDTH,
    PANEL_DIVIDER_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    type PanelLayout,
} from './panel-layout';

describe('clampWidth', () => {
    it('holds a value already within bounds', () => {
        expect(clampWidth(300, 180, 480)).toBe(300);
    });

    it('floors a value below the minimum', () => {
        expect(clampWidth(50, 180, 480)).toBe(180);
    });

    it('ceils a value above the maximum', () => {
        expect(clampWidth(900, 180, 480)).toBe(480);
    });

    it('falls back to the minimum for a non-finite width', () => {
        expect(clampWidth(Number.NaN, 180, 480)).toBe(180);
        expect(clampWidth(Number.POSITIVE_INFINITY, 180, 480)).toBe(180);
    });
});

describe('clampLayoutToViewport', () => {
    const wideLayout: PanelLayout = {
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
        sidebarVisible: true,
        inspectorVisible: true,
    };

    it('leaves widths untouched when the viewport has plenty of room', () => {
        expect(clampLayoutToViewport(wideLayout, 1600)).toEqual(wideLayout);
    });

    it('shrinks the Inspector before the Sidebar as the viewport narrows', () => {
        const viewportWidth =
            SIDEBAR_DEFAULT_WIDTH +
            INSPECTOR_DEFAULT_WIDTH +
            MIN_MAIN_WIDTH +
            PANEL_DIVIDER_WIDTH * 2 -
            40;

        const next = clampLayoutToViewport(wideLayout, viewportWidth);

        expect(next.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
        expect(next.inspectorWidth).toBe(INSPECTOR_DEFAULT_WIDTH - 40);
    });

    it('shrinks the Sidebar once the Inspector has reached its minimum', () => {
        const viewportWidth =
            SIDEBAR_DEFAULT_WIDTH +
            INSPECTOR_MIN_WIDTH +
            MIN_MAIN_WIDTH +
            PANEL_DIVIDER_WIDTH * 2 -
            20;

        const next = clampLayoutToViewport(wideLayout, viewportWidth);

        expect(next.inspectorWidth).toBe(INSPECTOR_MIN_WIDTH);
        expect(next.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH - 20);
    });

    it('never shrinks either panel below its own minimum, even in a very narrow viewport', () => {
        const next = clampLayoutToViewport(wideLayout, 200);

        expect(next.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
        expect(next.inspectorWidth).toBe(INSPECTOR_MIN_WIDTH);
    });

    it('ignores the Inspector width in the overflow budget once it is collapsed', () => {
        const collapsed: PanelLayout = { ...wideLayout, inspectorVisible: false };
        const viewportWidth = SIDEBAR_DEFAULT_WIDTH + MIN_MAIN_WIDTH + PANEL_DIVIDER_WIDTH + 10;

        const next = clampLayoutToViewport(collapsed, viewportWidth);

        expect(next.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
        expect(next.inspectorVisible).toBe(false);
    });

    it('ignores the Sidebar width in the overflow budget once it is collapsed', () => {
        const collapsed: PanelLayout = { ...wideLayout, sidebarVisible: false };
        const viewportWidth = INSPECTOR_DEFAULT_WIDTH + MIN_MAIN_WIDTH + PANEL_DIVIDER_WIDTH + 10;

        const next = clampLayoutToViewport(collapsed, viewportWidth);

        expect(next.inspectorWidth).toBe(INSPECTOR_DEFAULT_WIDTH);
        expect(next.sidebarVisible).toBe(false);
    });

    it('clamps an out-of-range persisted width even when the viewport is not the constraint', () => {
        const stale: PanelLayout = { ...wideLayout, sidebarWidth: 10_000 };

        const next = clampLayoutToViewport(stale, 1600);

        expect(next.sidebarWidth).toBeLessThanOrEqual(480);
    });
});
