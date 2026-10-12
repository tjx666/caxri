import type { Translate } from '../../i18n';

/**
 * The zoom of a picture preview (an SVG image or a Mermaid diagram): `fit` keeps the whole picture in view and follows
 * the pane as it resizes; a number is a fixed scale, 1 being the picture's natural size.
 */
export type PreviewZoom = 'fit' | number;

export const PREVIEW_ZOOM_CHOICES: readonly PreviewZoom[] = ['fit', 0.5, 0.75, 1, 1.5, 2, 3];

/**
 * The scale range a pinch or a zoom step can reach. Wider than the menu: the menu offers the common stops, a pinch goes
 * as far as reading a hairline or seeing a whole poster-sized diagram.
 */
export const MIN_PREVIEW_SCALE = 0.1;
export const MAX_PREVIEW_SCALE = 8;

/**
 * Floor for Fit, only so a degenerate pane never produces a zero or negative scale.
 */
const MIN_FIT_SCALE = 0.01;

/**
 * Factor a step past the last fixed choice multiplies by, the same 25% a browser zoom step moves.
 */
const STEP_FACTOR = 1.25;

export interface PictureSize {
    width: number;
    height: number;
}

export function clampPreviewScale(scale: number): number {
    return Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, scale));
}

/**
 * The scale that shows the whole picture inside the viewport less its padding on every side. It never enlarges past the
 * natural size: a small icon stays crisp at 100% instead of being blown up to fill the pane, which is what the preview
 * did before it could zoom at all.
 */
export function fitPreviewScale(
    picture: PictureSize,
    viewport: PictureSize,
    padding: number,
): number {
    if (picture.width <= 0 || picture.height <= 0) return 1;
    const width = Math.max(1, viewport.width - 2 * padding) / picture.width;
    const height = Math.max(1, viewport.height - 2 * padding) / picture.height;
    // Not held to the step range: Fit promises the whole picture, however narrow the pane.
    return Math.max(MIN_FIT_SCALE, Math.min(1, width, height));
}

/**
 * The scale one Zoom In or Zoom Out step lands on: the next fixed choice in that direction, or a 25% step once past the
 * last one, within the scale range.
 */
export function stepPreviewScale(scale: number, direction: 'in' | 'out'): number {
    const stops = PREVIEW_ZOOM_CHOICES.filter((choice): choice is number => choice !== 'fit');
    // A tolerance, so a scale a hair off a stop (from a pinch) does not step to that same stop.
    const epsilon = 0.001;
    if (direction === 'in') {
        const next = stops.find((stop) => stop > scale + epsilon);
        return Math.max(scale, clampPreviewScale(next ?? scale * STEP_FACTOR));
    }
    const next = stops.findLast((stop) => stop < scale - epsilon);
    // Never a step the wrong way: a Fit below the step range stays put rather than jumping up to the range.
    return Math.min(scale, clampPreviewScale(next ?? scale / STEP_FACTOR));
}

/**
 * The scale factor of one Ctrl+wheel event. Chromium reports a trackpad pinch as a Ctrl+wheel whose `deltaY` grows with
 * the pinch, and a mouse's Ctrl+wheel as larger steps; the exponential keeps pinching out and back in symmetrical.
 */
export function pinchScaleFactor(deltaY: number): number {
    return Math.exp(-deltaY / 100);
}

/**
 * Where the picture's leading edge sits along one axis of the scroll content: centered while it is smaller than the
 * viewport, otherwise at the padding.
 */
function pictureOrigin(viewport: number, picture: number, scale: number, padding: number): number {
    return Math.max(padding, (viewport - picture * scale) / 2);
}

interface AnchoredScroll {
    /**
     * The scroll offset before the zoom.
     */
    scroll: number;
    /**
     * The pointer position relative to the viewport's leading edge.
     */
    pointer: number;
    viewport: number;
    /**
     * The picture's natural length.
     */
    picture: number;
    padding: number;
    scale: number;
    nextScale: number;
}

/**
 * The scroll offset along one axis that keeps the picture point under the pointer in place across a zoom, so pinching
 * zooms into what the reader is pointing at.
 */
export function anchoredScrollOffset({
    scroll,
    pointer,
    viewport,
    picture,
    padding,
    scale,
    nextScale,
}: AnchoredScroll): number {
    const point = (scroll + pointer - pictureOrigin(viewport, picture, scale, padding)) / scale;
    const next = point * nextScale + pictureOrigin(viewport, picture, nextScale, padding) - pointer;
    const max = Math.max(0, picture * nextScale + 2 * padding - viewport);
    return Math.min(max, Math.max(0, next));
}

/**
 * The menu text for a zoom choice: Fit by name, a fixed scale as its percentage.
 */
export function previewZoomLabel(choice: PreviewZoom, t: Translate): string {
    return choice === 'fit' ? t('preview.zoom.fit') : `${Math.round(choice * 100)}%`;
}
