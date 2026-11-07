export const TABLET_SPLIT_WIDTH = 700;
export const TABLET_MIN_SHORT_SIDE = 600;
export const WIDE_TABLET_WIDTH = 1_100;

export type MobileLayoutMode = 'phone' | 'tablet-split' | 'tablet-wide';

export const mobileLayoutMode = (width: number, height: number): MobileLayoutMode => {
    if (width < TABLET_SPLIT_WIDTH || Math.min(width, height) < TABLET_MIN_SHORT_SIDE)
        return 'phone';
    return width >= WIDE_TABLET_WIDTH ? 'tablet-wide' : 'tablet-split';
};

/**
 * Whether the Session side panel docks beside the content, which only a wide tablet has room for; every other layout
 * opens it as a drawer over the Session.
 */
export const isSessionSidePanelDocked = (layout: MobileLayoutMode): boolean =>
    layout === 'tablet-wide';
