import type { AnnotationPoint } from './screenshot-annotations';
import { ANNOTATION_COLOR } from './screenshot-annotations';

/**
 * The keyboard caret is deliberately not annotation ink: it is `--accent` through `currentColor`, because it marks
 * where focus is acting and never reaches the rasterized JPEG, unlike {@link ANNOTATION_COLOR}, which has to survive the
 * export.
 */
const cursorProperties = {
    fill: 'none',
    pointerEvents: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    vectorEffect: 'non-scaling-stroke',
} as const;

/**
 * Half the crosshair's arm, in CSS pixels at the annotator's display size; `scale` converts it to image pixels the way
 * every other on-screen size in this overlay is converted.
 */
const CURSOR_ARM = 10;

/**
 * Where the keyboard is about to place or drag a mark, drawn inside the annotation canvas's own SVG.
 *
 * Lives beside the canvas rather than in it because the canvas already owns the three mark components; this one shares
 * none of their stroke presentation, so the split costs nothing.
 */
export function ScreenshotAnnotationCursor({
    point,
    scale,
}: {
    point: AnnotationPoint;
    scale: number;
}) {
    const arm = CURSOR_ARM * scale;
    return (
        // Visible only while the overlay itself holds keyboard focus: the position survives a trip to the note field,
        // but DESIGN.md allows one resting `--accent` focus per screen, and a caret left glowing on a blurred surface
        // would be a second one.
        <g className="text-accent opacity-0 group-focus-visible:opacity-100">
            <line
                {...cursorProperties}
                x1={point.x - arm}
                x2={point.x + arm}
                y1={point.y}
                y2={point.y}
            />
            <line
                {...cursorProperties}
                x1={point.x}
                x2={point.x}
                y1={point.y - arm}
                y2={point.y + arm}
            />
            <circle {...cursorProperties} cx={point.x} cy={point.y} r={arm / 2} />
        </g>
    );
}
