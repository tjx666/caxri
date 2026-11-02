import type { SessionListEntry } from './hooks/use-session-polling';

export const activeProjectFilter = (
    selectedProjectId: string | null,
    projects: ReadonlyArray<{ id: string }>,
): string | null =>
    selectedProjectId !== null && projects.some(({ id }) => id === selectedProjectId)
        ? selectedProjectId
        : null;
export const filterSessionEntries = (
    entries: SessionListEntry[],
    projectId: string | null,
): SessionListEntry[] => {
    if (projectId === null) return entries;
    const result: SessionListEntry[] = [];
    let header: SessionListEntry | null = null;
    for (const entry of entries) {
        if (entry.type === 'header') {
            header = entry;
            continue;
        }
        if (entry.session.projectId !== projectId) continue;
        if (header) {
            result.push(header);
            header = null;
        }
        result.push(entry);
    }
    return result;
};

type ProjectFilterSwipe = 'next' | 'previous';

/**
 * Distance, as a share of the list's width, and fling speed (points per second) past which a sideways drag over the
 * Session list moves to the neighboring Project filter. A shorter or slower drag springs back, as in the image viewer.
 */
const SWIPE_DISTANCE_RATIO = 0.2;
const SWIPE_FLING_VELOCITY = 800;
const SWIPE_FLING_MIN_DISTANCE = 32;

/**
 * Which way a sideways drag over the Session list turns the Project filters when it ends: a leftward drag moves to the
 * next chip and a rightward one to the previous chip, the way paged tabs follow the finger.
 */
export const projectFilterSwipe = (
    drag: { translationX: number; velocityX: number },
    width: number,
): ProjectFilterSwipe | null => {
    'worklet';
    const { translationX, velocityX } = drag;
    const isFar = Math.abs(translationX) > width * SWIPE_DISTANCE_RATIO;
    const isFling =
        Math.abs(velocityX) > SWIPE_FLING_VELOCITY &&
        Math.abs(translationX) > SWIPE_FLING_MIN_DISTANCE &&
        Math.sign(velocityX) === Math.sign(translationX);
    if (!isFar && !isFling) return null;
    return translationX < 0 ? 'next' : 'previous';
};

/**
 * Share of a drag past the first or last page that the pages still follow, so either end resists the finger and springs
 * back instead of wrapping around, as a native pager does.
 */
const PAGER_EDGE_RESISTANCE = 0.3;

/**
 * Where the Project pager sits while a finger drags it, in points from the first page: it follows the finger one to one
 * between the first and last page and only partly past either end.
 */
export const projectPagerPosition = (
    start: number,
    dragX: number,
    pageCount: number,
    width: number,
): number => {
    'worklet';
    const position = start - dragX;
    if (position < 0) return position * PAGER_EDGE_RESISTANCE;
    const last = Math.max(0, pageCount - 1) * width;
    if (position > last) return last + (position - last) * PAGER_EDGE_RESISTANCE;
    return position;
};

/**
 * The page a released drag settles on, in the chips' order (All, then each Project): the neighbor in the swipe's
 * direction, or the current page for a short drag or past either end.
 */
export const projectPagerTarget = (
    activeIndex: number,
    pageCount: number,
    drag: { translationX: number; velocityX: number },
    width: number,
): number => {
    'worklet';
    const swipe = projectFilterSwipe(drag, width);
    if (swipe === null) return activeIndex;
    const next = activeIndex + (swipe === 'next' ? 1 : -1);
    return next < 0 || next >= pageCount ? activeIndex : next;
};

/**
 * The pages kept mounted around the current one, so a swipe in either direction finds its neighbor already drawn.
 */
export const projectPagerWindow = (activeIndex: number, pageCount: number): number[] => {
    const pages: number[] = [];
    for (let index = activeIndex - 1; index <= activeIndex + 1; index += 1)
        if (index >= 0 && index < pageCount) pages.push(index);
    return pages;
};
