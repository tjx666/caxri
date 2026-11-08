import type { FrameGeometry, GrayFrame } from './mobile-motion-analysis';

/**
 * The drawer is 88% of a phone's width, so the left tenth shows only the scrim over the Session.
 */
const SCRIM_STRIP = 0.1;
/**
 * Where the open drawer begins, as a share of the width.
 */
const DRAWER_LEFT = 0.12;
/**
 * The last part of the drawer's travel, as a share of its width. Once only this sliver remains on screen, too little of
 * the drawer is left to match, so those frames are not judged.
 */
const DRAWER_TAIL = 0.15;
/**
 * Pixels closer than this to the background are treated as empty, which removes video compression noise.
 */
const INK_FLOOR = 24;
/**
 * Smallest share of the open drawer's ink that a moving frame must reproduce at the drawer's offset. A drawer that
 * slides as one opaque picture reproduces nearly all of it; one that lost its own and its controls' backgrounds
 * reproduces about half.
 */
const MIN_DRAWER_MATCH = 0.75;
/**
 * Below this share no part of the drawer is on screen any more: the frame only shows the scrim's last fade over the
 * Session. A drawer that lost its backgrounds still reproduces about half its ink, so it stays well above this.
 */
const DRAWER_GONE = 0.2;
/**
 * Smallest brightness difference between the open and closed scrim strip that the fade judgement can resolve.
 */
const MIN_SCRIM_SPAN = 6;
/**
 * Mean absolute luma difference above which two pictures differ.
 */
const DIFFERENT_PICTURE = 2;

const columnsDifference = (
    a: GrayFrame,
    b: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
    to: number,
): number => {
    let sum = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < to; column += 1) {
            const index = row * width + column;
            sum += Math.abs(a.data[index] - b.data[index]);
        }
    return sum / (height * (to - from));
};

const columnsMean = (
    { data }: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
    to: number,
): number => {
    let sum = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < to; column += 1) sum += data[row * width + column];
    return sum / (height * (to - from));
};

const backgroundOf = ({ data }: GrayFrame): number => {
    const histogram = new Uint32Array(256);
    for (const value of data) histogram[value] += 1;
    let mode = 0;
    for (let value = 1; value < 256; value += 1)
        if (histogram[value] > histogram[mode]) mode = value;
    return mode;
};

/**
 * The open drawer's ink pixels as row-major indices, and the best share of them a frame reproduces at any rightward
 * offset.
 */
const drawerMatcher = (opened: GrayFrame, { height, width }: FrameGeometry, background: number) => {
    const left = Math.ceil(width * DRAWER_LEFT);
    const isInk = (value: number) => Math.abs(value - background) > INK_FLOOR;
    const ink: Array<{ column: number; row: number }> = [];
    for (let row = 0; row < height; row += 1)
        for (let column = left; column < width; column += 1)
            if (isInk(opened.data[row * width + column])) ink.push({ column, row });
    /**
     * The share of the open drawer's ink a frame shows at `offset`, or `null` once too little of the drawer is left on
     * screen to judge.
     */
    const matchAt = (data: Uint8Array, offset: number): number | null => {
        const shown = ink.filter(({ column }) => column + offset < width);
        if (shown.length < ink.length * DRAWER_TAIL) return null;
        const matched = shown.filter(({ column, row }) =>
            isInk(data[row * width + column + offset]),
        ).length;
        return matched / shown.length;
    };
    return ({ data }: GrayFrame): number => {
        let best = 0;
        for (let offset = 0; offset < width - left; offset += 1) {
            const match = matchAt(data, offset);
            if (match === null) break;
            best = Math.max(best, match);
        }
        return best;
    };
};

/**
 * Judges one recorded close of the phone drawer. The first frame shows the drawer open and the last shows it closed.
 *
 * - `movingFrames`: frames whose drawer area matches neither settled picture, so something visibly moves.
 * - `tornFrames`: moving frames in which part of the drawer is still on screen but no longer reads as one picture at any
 *   offset. The drawer and the Session share a background colour, so a drawer that lost its backgrounds looks the same
 *   size; what gives it away is that the selected tab and filter pills lose their fills and the Session's text shows
 *   through between the drawer's.
 * - `scrimFadeFrames`: frames whose scrim strip sits between its open and closed brightness.
 *
 * The close animation runs 220 ms and `screenrecord` delivers roughly 30 to 60 frames a second while the screen
 * changes, so a real slide or fade spans several frames; three moving and two fading frames are conservative floors.
 */
export function analyseDrawerClose(
    frames: readonly GrayFrame[],
    geometry: FrameGeometry,
): { movingFrames: number; scrimFadeFrames: number; scrimSpan: number; tornFrames: number } {
    const [opened] = frames;
    const closed = frames.at(-1);
    if (!closed) throw new Error('Recording has no frames');
    const { width } = geometry;
    const stripTo = Math.max(1, Math.floor(width * SCRIM_STRIP));
    const left = Math.ceil(width * DRAWER_LEFT);
    const tailFrom = width - Math.floor((width - left) * DRAWER_TAIL);
    const openLevel = columnsMean(opened, geometry, 0, stripTo);
    const closedLevel = columnsMean(closed, geometry, 0, stripTo);
    const low = Math.min(openLevel, closedLevel);
    const span = Math.abs(closedLevel - openLevel);
    if (span < MIN_SCRIM_SPAN)
        throw new Error(
            `The scrim strip barely changes when the drawer closes (${span.toFixed(1)})`,
        );
    const scrimFadeFrames = frames.filter((frame) => {
        const level = columnsMean(frame, geometry, 0, stripTo);
        return level > low + span * 0.15 && level < low + span * 0.85;
    }).length;
    const drawerMatch = drawerMatcher(opened, geometry, backgroundOf(closed));
    const moving = frames.filter(
        (frame) =>
            columnsDifference(frame, opened, geometry, left, width) > DIFFERENT_PICTURE &&
            columnsDifference(frame, closed, geometry, left, tailFrom) > DIFFERENT_PICTURE,
    );
    const tornFrames = moving.filter((frame) => {
        const match = drawerMatch(frame);
        return match >= DRAWER_GONE && match < MIN_DRAWER_MATCH;
    }).length;
    return { movingFrames: moving.length, scrimFadeFrames, scrimSpan: span, tornFrames };
}
