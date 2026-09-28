import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * One grayscale video frame of the analysed band, row-major, one byte per pixel.
 */
export interface GrayFrame {
    data: Uint8Array;
    /**
     * Presentation time in milliseconds.
     */
    time: number;
}

export interface FrameGeometry {
    height: number;
    width: number;
}

/**
 * A screen rectangle in device pixels.
 */
export interface ScreenRect {
    bottom: number;
    left: number;
    right: number;
    top: number;
}

/**
 * The part of the screen a decoded RGB frame covers: `columns` x `rows` samples taken every `scale` device pixels from
 * `left`, `top`.
 */
export interface SampledArea {
    columns: number;
    left: number;
    rows: number;
    scale: number;
    top: number;
}

type PanelEntry = 'from-left' | 'from-right' | 'in-place';

export interface PanelTransition {
    /**
     * Horizontal offset of each moving frame from the settled panel, in analysed columns; positive is to the right.
     */
    displacements: number[];
    entry: PanelEntry;
    settledAt: number;
}

interface AnalysisOptions {
    /**
     * Largest horizontal offset searched, in analysed columns.
     */
    maxShift: number;
    /**
     * Smallest offset that counts as motion rather than rounding.
     */
    minShift: number;
    /**
     * Smallest largest offset for a transition to read as a slide. A panel that appears after its entering animation
     * has almost finished only moves a column or two, which a reader does not see as motion.
     */
    minTravel: number;
    /**
     * A new panel counts as settled once it stays unchanged for this long.
     */
    settleMs: number;
}

const defaultOptions: AnalysisOptions = { maxShift: 24, minShift: 2, minTravel: 5, settleMs: 300 };

/**
 * Pixels closer than this to the background are treated as empty, which removes video compression noise.
 */
const INK_FLOOR = 12;
/**
 * Mean absolute luma difference under which two frames show the same picture.
 */
const SAME_PICTURE = 1.5;
/**
 * Share of inked pixels under which the region counts as empty.
 */
const BLANK_COVERAGE = 0.002;
/**
 * Minimum normalized correlation for a moving frame to count as the settled panel at an offset.
 */
const MIN_CORRELATION = 0.6;

const backgroundOf = (frame: GrayFrame): number => {
    const histogram = new Uint32Array(256);
    for (const value of frame.data) histogram[value] += 1;
    let mode = 0;
    for (let value = 1; value < 256; value += 1)
        if (histogram[value] > histogram[mode]) mode = value;
    return mode;
};

const inkOf = (frame: GrayFrame, background: number): Float32Array =>
    Float32Array.from(frame.data, (value) => Math.max(0, Math.abs(value - background) - INK_FLOOR));

const isDifferent = (left: GrayFrame, right: GrayFrame): boolean => {
    let total = 0;
    for (let index = 0; index < left.data.length; index += 1)
        total += Math.abs(left.data[index] - right.data[index]);
    return total / left.data.length >= SAME_PICTURE;
};

const inkCoverage = (ink: Float32Array): number => {
    let covered = 0;
    for (const value of ink) if (value > 0) covered += 1;
    return covered / ink.length;
};

/**
 * Finds the horizontal offset at which `frame` best matches the settled `reference`, by normalized correlation over the
 * overlapping columns. Correlation ignores the frame's overall brightness, so a panel that is still fading in matches
 * as well as an opaque one.
 */
function displacementOf(
    frame: Float32Array,
    reference: Float32Array,
    { height, width }: FrameGeometry,
    maxShift: number,
): { correlation: number; shift: number } {
    let best = { correlation: -1, shift: 0 };
    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
        let product = 0;
        let frameEnergy = 0;
        let referenceEnergy = 0;
        for (let row = 0; row < height; row += 1) {
            const offset = row * width;
            for (
                let column = Math.max(0, shift);
                column < Math.min(width, width + shift);
                column += 1
            ) {
                const value = frame[offset + column];
                const expected = reference[offset + column - shift];
                product += value * expected;
                frameEnergy += value * value;
                referenceEnergy += expected * expected;
            }
        }
        const correlation =
            frameEnergy > 0 && referenceEnergy > 0
                ? product / Math.sqrt(frameEnergy * referenceEnergy)
                : 0;
        if (correlation > best.correlation) best = { correlation, shift };
    }
    return best;
}

/**
 * Splits a recording of one screen region into panel changes and reports from which side each new panel entered.
 *
 * A panel is settled once its picture holds for `settleMs`; an empty region never counts as settled, so the blank
 * frames between an unmounted panel and a still-positioning one stay inside the transition. Every transition frame that
 * already shows the new panel is matched against the settled picture to find its horizontal offset.
 */
export function panelTransitions(
    frames: GrayFrame[],
    geometry: FrameGeometry,
    options: Partial<AnalysisOptions> = {},
): PanelTransition[] {
    const { maxShift, minShift, minTravel, settleMs } = { ...defaultOptions, ...options };
    if (frames.length === 0) return [];
    const background = backgroundOf(frames[0]);
    const inks = frames.map((frame) => inkOf(frame, background));
    const isBlank = (index: number) => inkCoverage(inks[index]) < BLANK_COVERAGE;
    const settledFrom = (start: number): number | null => {
        for (let candidate = start; candidate < frames.length;) {
            let next = candidate + 1;
            while (next < frames.length && !isDifferent(frames[next], frames[candidate])) next += 1;
            const holdsUntil = next < frames.length ? frames[next].time : Infinity;
            if (!isBlank(candidate) && holdsUntil - frames[candidate].time >= settleMs)
                return candidate;
            candidate = next;
        }
        return null;
    };

    const transitions: PanelTransition[] = [];
    let anchor = settledFrom(0);
    if (anchor === null) return [];
    for (let index = anchor + 1; index < frames.length; index += 1) {
        if (!isDifferent(frames[index], frames[anchor])) continue;
        const settled = settledFrom(index);
        if (settled === null) break;
        const displacements = inks
            .slice(index, settled)
            .filter((ink) => inkCoverage(ink) >= BLANK_COVERAGE)
            .map((ink) => displacementOf(ink, inks[settled], geometry, maxShift))
            .filter(
                ({ correlation, shift }) =>
                    correlation >= MIN_CORRELATION && Math.abs(shift) >= minShift,
            )
            .map(({ shift }) => shift);
        const rightward = displacements.filter((shift) => shift > 0).length;
        const leftward = displacements.length - rightward;
        const travel = Math.max(0, ...displacements.map((shift) => Math.abs(shift)));
        transitions.push({
            displacements,
            entry:
                travel < minTravel ? 'in-place' : rightward > leftward ? 'from-right' : 'from-left',
            settledAt: frames[settled].time,
        });
        anchor = settled;
        index = settled;
    }
    return transitions;
}

/**
 * A red channel this far above both others marks the danger colour that fills a destructive swipe action; text, icons,
 * and the Dracula background all stay well below it.
 */
const RED_MARGIN = 60;

/**
 * Share of the samples inside `region` that show a strongly red colour, such as a revealed Archive action. A sample
 * counts when its device pixel lies inside the region; the frame holds RGB triples for `area`.
 */
export function redShare(pixels: Uint8Array, area: SampledArea, region: ScreenRect): number {
    const firstRow = Math.max(0, Math.ceil((region.top - area.top) / area.scale));
    const lastRow = Math.min(area.rows, Math.ceil((region.bottom - area.top) / area.scale));
    const firstColumn = Math.max(0, Math.ceil((region.left - area.left) / area.scale));
    const lastColumn = Math.min(area.columns, Math.ceil((region.right - area.left) / area.scale));
    let total = 0;
    let red = 0;
    for (let row = firstRow; row < lastRow; row += 1)
        for (let column = firstColumn; column < lastColumn; column += 1) {
            const offset = (row * area.columns + column) * 3;
            total += 1;
            if (pixels[offset] - Math.max(pixels[offset + 1], pixels[offset + 2]) > RED_MARGIN)
                red += 1;
        }
    return total === 0 ? 0 : red / total;
}

/**
 * Presentation times in milliseconds for every frame of a recording, and its width in device pixels.
 */
async function probeRecording(path: string): Promise<{ times: number[]; width: number }> {
    const probe = await execFileAsync(
        'ffprobe',
        [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width:frame=pts_time',
            '-of',
            'json',
            path,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
    );
    const { frames: probed, streams } = JSON.parse(probe.stdout) as {
        frames: Array<{ pts_time: string }>;
        streams: Array<{ width: number }>;
    };
    const width = streams[0]?.width;
    if (!width) throw new Error('Recording has no video stream');
    return { times: probed.map(({ pts_time: time }) => Number(time) * 1000), width };
}

/**
 * Decodes every frame of a recording inside the rows `top`..`bottom`, scaled down by `scale` in both directions. The
 * frames keep their own presentation times because `screenrecord` only writes a frame when the screen changes.
 */
export async function readRecordingBand(
    path: string,
    { bottom, top }: { bottom: number; top: number },
    scale = 4,
): Promise<{ frames: GrayFrame[]; geometry: FrameGeometry; scale: number }> {
    const { times, width: videoWidth } = await probeRecording(path);
    const cropHeight = Math.floor((bottom - top) / scale) * scale;
    const cropWidth = Math.floor(videoWidth / scale) * scale;
    const geometry = { height: cropHeight / scale, width: cropWidth / scale };
    const decoded = await execFileAsync(
        'ffmpeg',
        [
            '-v',
            'error',
            '-i',
            path,
            '-fps_mode',
            'passthrough',
            '-vf',
            `crop=${cropWidth}:${cropHeight}:0:${top},scale=${geometry.width}:${geometry.height}:flags=area,format=gray`,
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
    );
    const frameBytes = geometry.width * geometry.height;
    const count = decoded.stdout.length / frameBytes;
    if (!Number.isSafeInteger(count) || count !== times.length)
        throw new Error('Recording frames do not match their timestamps');
    const frames = times.map((time, index) => ({
        data: new Uint8Array(decoded.stdout.subarray(index * frameBytes, (index + 1) * frameBytes)),
        time,
    }));
    return { frames, geometry, scale };
}

/**
 * For every frame of a recording, the red share of each region (see `redShare`), sampled every `scale` device pixels.
 * The decoded area is aligned to `scale` so the crop stays on even pixels, which the recording's chroma layout needs.
 */
export async function readRecordingRedShares(
    path: string,
    regions: ScreenRect[],
    scale = 4,
): Promise<Array<{ shares: number[]; time: number }>> {
    const { times, width: videoWidth } = await probeRecording(path);
    const align = (value: number) => Math.floor(value / scale) * scale;
    const left = align(Math.min(...regions.map((region) => region.left)));
    const top = align(Math.min(...regions.map((region) => region.top)));
    const right = Math.min(videoWidth, Math.max(...regions.map((region) => region.right)));
    const area: SampledArea = {
        columns: Math.min(
            Math.ceil((right - left) / scale),
            Math.floor((videoWidth - left) / scale),
        ),
        left,
        rows: Math.ceil((Math.max(...regions.map((region) => region.bottom)) - top) / scale),
        scale,
        top,
    };
    const decoded = await execFileAsync(
        'ffmpeg',
        [
            '-v',
            'error',
            '-i',
            path,
            '-fps_mode',
            'passthrough',
            '-vf',
            `crop=${area.columns * scale}:${area.rows * scale}:${left}:${top},scale=${area.columns}:${area.rows}:flags=neighbor,format=rgb24`,
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
    );
    const frameBytes = area.columns * area.rows * 3;
    const count = decoded.stdout.length / frameBytes;
    if (!Number.isSafeInteger(count) || count !== times.length)
        throw new Error('Recording frames do not match their timestamps');
    return times.map((time, index) => {
        const pixels = decoded.stdout.subarray(index * frameBytes, (index + 1) * frameBytes);
        return { shares: regions.map((region) => redShare(pixels, area, region)), time };
    });
}
