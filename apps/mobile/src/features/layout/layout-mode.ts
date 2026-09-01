export const TABLET_SPLIT_WIDTH = 700;

export type MobileLayoutMode = 'phone' | 'tablet-split';

export const mobileLayoutMode = (width: number): MobileLayoutMode =>
    width >= TABLET_SPLIT_WIDTH ? 'tablet-split' : 'phone';
