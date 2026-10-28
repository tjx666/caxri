import type { TextStyle } from 'react-native';

/**
 * The mobile type scale from `docs/mobile/design.md` ("Type and spacing"). Every text style starts from one of these
 * steps and only adds color, alignment, or `tabular-nums`; a size between steps is a design change, made here first.
 */
export const mobileType = {
    /**
     * A screen's title in its header, such as Settings or Agent usage.
     */
    title: { fontSize: 22, fontWeight: '700', lineHeight: 28 },
    /**
     * A Session's title, a sheet's title, or a card's headline.
     */
    heading: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
    /**
     * Reading text: Agent replies, file contents, sheet rows.
     */
    body: { fontSize: 15, lineHeight: 22 },
    /**
     * The name of a row or a button's label.
     */
    bodyStrong: { fontSize: 15, fontWeight: '600', lineHeight: 22 },
    /**
     * Metadata and secondary lines: a row's Project and age, a card's detail, a notice's sentence.
     */
    meta: { fontSize: 13, lineHeight: 18 },
    /**
     * Compact state labels, badges, and footnotes.
     */
    caption: { fontSize: 12, lineHeight: 16 },
    /**
     * An uppercase section heading such as `NEEDS ATTENTION` or `MEMORY`.
     */
    section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, lineHeight: 16 },
} as const satisfies Record<string, TextStyle>;

/**
 * Spacing on the 4dp grid. `xxs` (2) exists only for hairline-adjacent nudges such as a title's gap to its subtitle.
 */
export const mobileSpace = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * Corner radii. `md` is the one radius for cards, docked panels, buttons, and banners, so sibling surfaces never
 * disagree by two points; `pill` is for chips and round controls.
 */
export const mobileRadius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/**
 * Control heights from the spec: every target is at least `row` (48dp); `primary` (52dp) is the one primary action of a
 * screen, such as Send or Create Session; a `chip` draws at 32dp and reaches 48dp through `chipHitSlop`.
 */
export const mobileControl = { chip: 32, row: 48, primary: 52 } as const;

/**
 * The extra touch area that lifts a {@link mobileControl.chip} to the 48dp minimum.
 */
export const chipHitSlop = { bottom: 8, left: 4, right: 4, top: 8 } as const;

/**
 * The pressed state of a control without its own pressed color: one opacity instead of each screen picking 0.6–0.8.
 */
export const PRESSED_OPACITY = 0.7;
