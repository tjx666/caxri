import { createContext } from 'react';

/**
 * How long a Session row takes to fade in, fade out, or slide to its new place. Matches the composer extras and docked
 * panels (180ms), so list motion reads as the same family.
 */
export const SESSION_LIST_MOTION_MS = 180;

/**
 * The order of a page's rows as one comparable value. A refresh that changes a row's content but not which rows show,
 * or their order, keeps the same value and must not animate.
 */
export const sessionListRowOrder = (rows: ReadonlyArray<{ id: string }>): string =>
    rows.map(({ id }) => id).join('\n');

/**
 * Whether a change in a page's rows should animate: a Session appearing, leaving, or moving between groups on the page
 * the user is looking at. The first rows a page shows and every off-screen page update apply at once, and reduced
 * motion never animates.
 */
export const shouldAnimateSessionListChange = ({
    isActive,
    isReducedMotion,
    nextOrder,
    previousOrder,
}: {
    isActive: boolean;
    isReducedMotion: boolean;
    nextOrder: string;
    previousOrder: string;
}): boolean => isActive && !isReducedMotion && previousOrder !== '' && previousOrder !== nextOrder;

/**
 * True while a page applies a change in which Sessions it lists, or their order. Cells animate only then: outside that
 * window FlashList recycles cells while scrolling, and a recycled cell moving to its next item must not slide or fade.
 */
export const SessionListMotionContext = createContext(false);
