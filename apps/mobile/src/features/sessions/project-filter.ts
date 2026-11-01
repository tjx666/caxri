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

export type ProjectFilterSwipe = 'next' | 'previous';

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
 * The filter a swipe lands on, in the chips' order (All, then each Project), or `undefined` past either end, where the
 * list springs back instead of wrapping around.
 */
export const adjacentProjectFilter = (
    activeProjectId: string | null,
    projectIds: readonly string[],
    swipe: ProjectFilterSwipe,
): string | null | undefined => {
    const order = [null, ...projectIds];
    const index = order.indexOf(activeProjectId);
    const next = index + (swipe === 'next' ? 1 : -1);
    return index === -1 || next < 0 || next >= order.length ? undefined : order[next];
};
