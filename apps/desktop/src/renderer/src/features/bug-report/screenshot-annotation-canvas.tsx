import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { clamp } from 'es-toolkit';
import { X } from 'lucide-react';

import { cn } from '../../lib/utilities';
import type {
    AnnotationPoint,
    AnnotationSegment,
    ScreenshotAnnotation,
    ScreenshotAnnotationKind,
} from './screenshot-annotations';
import {
    ANNOTATION_BADGE_TEXT_COLOR,
    ANNOTATION_COLOR,
    ANNOTATION_STROKE_WIDTH,
    annotationBadgePoint,
    arrowHeadPoints,
    isNegligibleDrag,
    normalizeBox,
} from './screenshot-annotations';

/**
 * Invisible stroke width, in CSS pixels, that makes a 2.5px outline clickable. Without it a shape could only be
 * selected by hitting its own hairline.
 */
const HIT_STROKE_WIDTH = 14;

function AnnotationShape({
    annotation,
    isSelected,
    onSelect,
    scale,
}: {
    annotation: AnnotationSegment & { kind: ScreenshotAnnotationKind };
    isSelected?: boolean;
    onSelect?: () => void;
    scale: number;
}) {
    const select = onSelect
        ? (event: ReactPointerEvent<SVGGElement>) => {
              // Selecting must not also start a new drag on the surface underneath.
              event.stopPropagation();
              onSelect();
          }
        : undefined;
    const strokeProperties = {
        fill: 'none',
        stroke: ANNOTATION_COLOR,
        strokeWidth: ANNOTATION_STROKE_WIDTH,
        vectorEffect: 'non-scaling-stroke',
    } as const;
    const haloProperties = {
        fill: 'none',
        stroke: ANNOTATION_COLOR,
        strokeOpacity: 0.3,
        strokeWidth: ANNOTATION_STROKE_WIDTH * 4,
        vectorEffect: 'non-scaling-stroke',
    } as const;
    const hitProperties = {
        fill: 'none',
        pointerEvents: 'stroke',
        stroke: 'transparent',
        strokeWidth: HIT_STROKE_WIDTH,
        vectorEffect: 'non-scaling-stroke',
    } as const;

    if (annotation.kind === 'box') {
        const box = normalizeBox(annotation);
        const geometry = { height: box.height, width: box.width, x: box.x, y: box.y };
        return (
            <g onPointerDown={select}>
                {isSelected && <rect {...geometry} {...haloProperties} />}
                <rect {...geometry} {...strokeProperties} />
                {select && <rect {...geometry} {...hitProperties} />}
            </g>
        );
    }

    const [firstBarb, secondBarb] = arrowHeadPoints(annotation, scale);
    const shaft = { x1: annotation.x1, x2: annotation.x2, y1: annotation.y1, y2: annotation.y2 };
    const head = `${firstBarb.x},${firstBarb.y} ${annotation.x2},${annotation.y2} ${secondBarb.x},${secondBarb.y}`;
    return (
        <g onPointerDown={select}>
            {isSelected && <line {...shaft} {...haloProperties} />}
            <line {...shaft} {...strokeProperties} />
            <polyline points={head} {...strokeProperties} strokeLinejoin="round" />
            {select && <line {...shaft} {...hitProperties} />}
        </g>
    );
}

/**
 * The sequential number badge and its delete control. Both live in a DOM layer over the image rather than inside the
 * SVG: the overlay's coordinate system is natural image pixels, so an SVG badge would shrink to a few pixels on a
 * high-resolution capture, and a real `<button>` keeps the delete affordance keyboard reachable.
 */
function AnnotationBadge({
    annotation,
    height,
    index,
    isSelected,
    onRemove,
    onSelect,
    width,
}: {
    annotation: ScreenshotAnnotation;
    height: number;
    index: number;
    isSelected: boolean;
    onRemove: () => void;
    onSelect: () => void;
    width: number;
}) {
    const point = annotationBadgePoint(annotation);
    return (
        <div
            // The rasterizer centers the badge circle on the anchor point, so shift the row by half the circle's
            // `size-6` (12px), not half the row: centering the whole row (circle plus delete button) would land the
            // circle left of where the exported image draws it.
            className="pointer-events-none absolute flex -translate-x-3 -translate-y-1/2 items-center gap-1"
            style={{ left: `${(point.x / width) * 100}%`, top: `${(point.y / height) * 100}%` }}
        >
            <button
                type="button"
                aria-label={`Select annotation ${index + 1}`}
                aria-pressed={isSelected}
                className={cn(
                    'pointer-events-auto grid size-6 cursor-pointer place-items-center rounded-full border-0 p-0 text-[11px] font-semibold',
                    isSelected && 'ring-2 ring-foreground',
                )}
                style={{ backgroundColor: ANNOTATION_COLOR, color: ANNOTATION_BADGE_TEXT_COLOR }}
                onClick={onSelect}
            >
                {index + 1}
            </button>
            <button
                type="button"
                aria-label={`Delete annotation ${index + 1}`}
                className="pointer-events-auto grid size-5 cursor-pointer place-items-center rounded-full border border-border bg-surface p-0 text-muted hover:text-foreground"
                onClick={onRemove}
            >
                <X aria-hidden="true" size={11} />
            </button>
        </div>
    );
}

interface ScreenshotAnnotationCanvasProperties {
    annotations: readonly ScreenshotAnnotation[];
    height: number;
    onCreate: (segment: AnnotationSegment) => void;
    onDisplayScaleChange: (scale: number) => void;
    onRemove: (id: string) => void;
    onRemoveSelected: () => void;
    onSelect: (id: string | undefined) => void;
    scale: number;
    selectedId: string | undefined;
    source: string;
    tool: ScreenshotAnnotationKind;
    width: number;
}

/**
 * The screenshot with its editable overlay. The `<img>` sizes itself inside the dialog and the wrapper shrink-wraps it,
 * so the absolutely positioned `<svg>` and badge layer share exactly the image's box — that is what lets the overlay's
 * `viewBox` stay in natural image pixels and every stored coordinate mean the same thing in the exported file and in
 * the report text.
 */
export function ScreenshotAnnotationCanvas({
    annotations,
    height,
    onCreate,
    onDisplayScaleChange,
    onRemove,
    onRemoveSelected,
    onSelect,
    scale,
    selectedId,
    source,
    tool,
    width,
}: ScreenshotAnnotationCanvasProperties) {
    const imageReference = useRef<HTMLImageElement>(null);
    const surfaceReference = useRef<SVGSVGElement>(null);
    const [draft, setDraft] = useState<AnnotationSegment>();

    useEffect(() => {
        const image = imageReference.current;
        if (!image) return;
        const report = (): void => {
            if (image.clientWidth > 0) onDisplayScaleChange(width / image.clientWidth);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(image);
        return () => observer.disconnect();
    }, [onDisplayScaleChange, width]);

    const pointFrom = (event: ReactPointerEvent<SVGSVGElement>): AnnotationPoint => {
        const box = event.currentTarget.getBoundingClientRect();
        return {
            x: clamp(((event.clientX - box.left) / box.width) * width, 0, width),
            y: clamp(((event.clientY - box.top) / box.height) * height, 0, height),
        };
    };

    const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
        if (event.button !== 0) return;
        const point = pointFrom(event);
        onSelect(undefined);
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft({ x1: point.x, x2: point.x, y1: point.y, y2: point.y });
    };

    const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
        if (!draft) return;
        const point = pointFrom(event);
        setDraft({ ...draft, x2: point.x, y2: point.y });
    };

    const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
        if (!draft) return;
        const point = pointFrom(event);
        const finished = { ...draft, x2: point.x, y2: point.y };
        setDraft(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        if (!isNegligibleDrag({ ...finished, kind: tool })) onCreate(finished);
    };

    const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        // Only the drawing surface itself deletes shapes; a Backspace typed in a note textarea must edit that text.
        event.preventDefault();
        onRemoveSelected();
    };

    const selectShape = (id: string): void => {
        onSelect(id);
        surfaceReference.current?.focus();
    };

    return (
        <div className="relative inline-block max-w-full">
            <img
                ref={imageReference}
                alt="Unredacted screenshot of the current Caxri window, including any open files and terminal output"
                className="block max-h-[70vh] max-w-full rounded border border-border object-contain"
                height={height}
                src={source}
                width={width}
            />
            <svg
                ref={surfaceReference}
                aria-label="Drag to mark an area of the screenshot"
                className={cn(
                    'absolute inset-0 size-full touch-none outline-none',
                    tool === 'box' ? 'cursor-crosshair' : 'cursor-copy',
                )}
                role="application"
                tabIndex={0}
                viewBox={`0 0 ${width} ${height}`}
                onKeyDown={handleKeyDown}
                onLostPointerCapture={() => setDraft(undefined)}
                onPointerCancel={() => setDraft(undefined)}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                {annotations.map((annotation) => (
                    <AnnotationShape
                        key={annotation.id}
                        annotation={annotation}
                        isSelected={annotation.id === selectedId}
                        scale={scale}
                        onSelect={() => selectShape(annotation.id)}
                    />
                ))}
                {draft && <AnnotationShape annotation={{ ...draft, kind: tool }} scale={scale} />}
            </svg>
            <div className="pointer-events-none absolute inset-0">
                {annotations.map((annotation, index) => (
                    <AnnotationBadge
                        key={annotation.id}
                        annotation={annotation}
                        height={height}
                        index={index}
                        isSelected={annotation.id === selectedId}
                        width={width}
                        onRemove={() => onRemove(annotation.id)}
                        onSelect={() => selectShape(annotation.id)}
                    />
                ))}
            </div>
        </div>
    );
}
