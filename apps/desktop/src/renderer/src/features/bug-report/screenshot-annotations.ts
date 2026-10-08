/**
 * Geometry, drawing, and report formatting for the Bug Report screenshot annotations.
 *
 * Every coordinate in this module is in natural image pixels, so the same values drive three surfaces without a second
 * conversion: the SVG overlay (whose `viewBox` is the natural image size), the offscreen canvas that rasterizes the
 * annotated JPEG, and the Markdown report the Agent reads. Keeping the math here rather than inside the annotator
 * components is what makes it testable: `.tsx` files are not unit-tested in this repository.
 */

export type ScreenshotAnnotationKind = 'arrow' | 'box';

/**
 * A drag expressed as its start and end point. A box uses the two points as opposite corners, an arrow as tail and tip.
 */
export interface AnnotationSegment {
    x1: number;
    x2: number;
    y1: number;
    y2: number;
}

export interface ScreenshotAnnotation extends AnnotationSegment {
    id: string;
    kind: ScreenshotAnnotationKind;
    note: string;
}

export interface AnnotationPoint {
    x: number;
    y: number;
}

export interface AnnotationRectangle extends AnnotationPoint {
    height: number;
    width: number;
}

/**
 * The annotation ink is a fixed literal instead of a DESIGN.md theme token on purpose: the identical color has to
 * appear in the live SVG overlay, in the JPEG written to a temporary file, and in whatever viewer the Agent opens that
 * file with. A themed token would repaint the overlay while the already-rasterized file kept the old ink, and no theme
 * can guarantee a mark that stays visible on top of an arbitrary screenshot.
 */
export const ANNOTATION_COLOR = '#f43f5e';
export const ANNOTATION_BADGE_TEXT_COLOR = '#ffffff';
/**
 * Stroke, badge, and arrow-head sizes are CSS pixels at the annotator's display size. `drawAnnotations` multiplies them
 * by the display scale so the rasterized image reproduces what the user drew instead of hairlines on a 4K capture.
 */
export const ANNOTATION_STROKE_WIDTH = 2.5;
export const ANNOTATION_BADGE_RADIUS = 12;
const ANNOTATION_BADGE_FONT_SIZE = 11;
const ARROW_HEAD_LENGTH = 14;
const ARROW_HEAD_ANGLE = Math.PI / 7;
/**
 * Drags below this many image pixels are treated as a click that missed a shape rather than a new annotation.
 */
const MINIMUM_DRAG_SIZE = 4;

/**
 * How many marks one report may carry. The report body is capped at 48 KiB by `bugReportText`, and the three draft
 * fields can already spend 12 000 characters each; twelve numbered annotation lines with a 500-character note apiece
 * keeps the whole payload comfortably inside that budget, which `bug-report.test.ts` asserts against the real schema.
 * The number is also a legibility limit: badges past a dozen stop being findable on a single window capture.
 */
export const MAX_ANNOTATIONS = 12;

/**
 * Longest note one mark may carry, enforced by the note textarea. Lives beside {@link MAX_ANNOTATIONS} because the two
 * numbers are only meaningful as a product: together they bound the annotation half of the report.
 */
export const ANNOTATION_NOTE_MAX_LENGTH = 500;

/**
 * The subset of `CanvasRenderingContext2D` the rasterizer touches. Narrowing it keeps `drawAnnotations` unit-testable
 * with a plain recording object, since the Renderer test project runs in a `node` environment with no canvas.
 */
export interface AnnotationRenderingContext {
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    beginPath(): void;
    fill(): void;
    fillStyle: CanvasFillStrokeStyles['fillStyle'];
    fillText(text: string, x: number, y: number): void;
    font: string;
    lineTo(x: number, y: number): void;
    lineWidth: number;
    moveTo(x: number, y: number): void;
    stroke(): void;
    strokeRect(x: number, y: number, width: number, height: number): void;
    strokeStyle: CanvasFillStrokeStyles['strokeStyle'];
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
}

/**
 * Turns a drag into a positive-size rectangle so a right-to-left or bottom-to-top drag marks the same area.
 */
export function normalizeBox(segment: AnnotationSegment): AnnotationRectangle {
    return {
        height: Math.abs(segment.y2 - segment.y1),
        width: Math.abs(segment.x2 - segment.x1),
        x: Math.min(segment.x1, segment.x2),
        y: Math.min(segment.y1, segment.y2),
    };
}

/**
 * A box needs both axes to be meaningful (a zero-height box is invisible), while an arrow only needs total length, so a
 * deliberate horizontal arrow survives.
 */
export function isNegligibleDrag(
    segment: AnnotationSegment & { kind: ScreenshotAnnotationKind },
    minimumSize = MINIMUM_DRAG_SIZE,
): boolean {
    if (segment.kind === 'arrow')
        return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) < minimumSize;
    const box = normalizeBox(segment);
    return box.width < minimumSize || box.height < minimumSize;
}

/**
 * Where the sequential number badge sits: a box carries it at its top-left corner, an arrow at its tail, so the badge
 * never covers the thing the mark points at.
 */
export function annotationBadgePoint(
    annotation: AnnotationSegment & { kind: ScreenshotAnnotationKind },
): AnnotationPoint {
    if (annotation.kind === 'arrow') return { x: annotation.x1, y: annotation.y1 };
    const box = normalizeBox(annotation);
    return { x: box.x, y: box.y };
}

/**
 * The two barbs of an arrow head, returned as explicit points instead of an SVG marker so the overlay and the
 * rasterized canvas draw byte-identical geometry.
 */
export function arrowHeadPoints(
    segment: AnnotationSegment,
    scale: number,
): [AnnotationPoint, AnnotationPoint] {
    const angle = Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1);
    const length = ARROW_HEAD_LENGTH * scale;
    return [
        {
            x: segment.x2 - length * Math.cos(angle - ARROW_HEAD_ANGLE),
            y: segment.y2 - length * Math.sin(angle - ARROW_HEAD_ANGLE),
        },
        {
            x: segment.x2 - length * Math.cos(angle + ARROW_HEAD_ANGLE),
            y: segment.y2 - length * Math.sin(angle + ARROW_HEAD_ANGLE),
        },
    ];
}

/**
 * Burns the annotations into a context already holding the screenshot at its natural size. `scale` is image pixels per
 * displayed CSS pixel, so strokes and badges keep the proportions the user saw while drawing.
 */
export function drawAnnotations(
    context: AnnotationRenderingContext,
    annotations: readonly ScreenshotAnnotation[],
    scale: number,
): void {
    context.lineWidth = ANNOTATION_STROKE_WIDTH * scale;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${ANNOTATION_BADGE_FONT_SIZE * scale}px system-ui, sans-serif`;
    for (const [index, annotation] of annotations.entries()) {
        context.strokeStyle = ANNOTATION_COLOR;
        if (annotation.kind === 'box') {
            const box = normalizeBox(annotation);
            context.strokeRect(box.x, box.y, box.width, box.height);
        } else {
            const [firstBarb, secondBarb] = arrowHeadPoints(annotation, scale);
            context.beginPath();
            context.moveTo(annotation.x1, annotation.y1);
            context.lineTo(annotation.x2, annotation.y2);
            context.moveTo(firstBarb.x, firstBarb.y);
            context.lineTo(annotation.x2, annotation.y2);
            context.lineTo(secondBarb.x, secondBarb.y);
            context.stroke();
        }
        const badge = annotationBadgePoint(annotation);
        context.beginPath();
        context.fillStyle = ANNOTATION_COLOR;
        context.arc(badge.x, badge.y, ANNOTATION_BADGE_RADIUS * scale, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = ANNOTATION_BADGE_TEXT_COLOR;
        context.fillText(String(index + 1), badge.x, badge.y);
    }
}

function formatAnnotationLocation(annotation: ScreenshotAnnotation): string {
    if (annotation.kind === 'arrow')
        return `[arrow from (${Math.round(annotation.x1)},${Math.round(annotation.y1)}) to (${Math.round(annotation.x2)},${Math.round(annotation.y2)})]`;
    const box = normalizeBox(annotation);
    return `[box x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}]`;
}

/**
 * One numbered Markdown list item per annotation, matching the badge numbers drawn on the image.
 *
 * `sanitizeNote` is injected rather than imported so this module stays free of the report's redaction rules (and of an
 * import cycle with `bug-report.ts`); the report always passes its own `safeText`. Whitespace is collapsed afterwards
 * because a multiline note would otherwise break the list into unnumbered lines.
 */
export function formatAnnotationLines(
    annotations: readonly ScreenshotAnnotation[],
    sanitizeNote: (note: string) => string = (note) => note,
): string[] {
    return annotations.map((annotation, index) => {
        const note = sanitizeNote(annotation.note).replaceAll(/\s+/g, ' ').trim();
        return `  ${index + 1}. ${formatAnnotationLocation(annotation)} ${note || '(no note)'}`;
    });
}
