import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { useLatestReference } from '../../hooks/use-latest-reference';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';
import type { PictureSize, PreviewZoom } from './preview-zoom';
import {
    anchoredScrollOffset,
    clampPreviewScale,
    fitPreviewScale,
    pinchScaleFactor,
    PREVIEW_ZOOM_CHOICES,
    previewZoomLabel,
    stepPreviewScale,
} from './preview-zoom';
import { ZoomControls } from './zoom-controls';

/**
 * Space kept around the picture, so its edges and a transparent picture's checkerboard border stay visible at Fit.
 */
const PADDING = 24;

const EMPTY_SIZE: PictureSize = { width: 0, height: 0 };

interface PanStart {
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
}

/**
 * A zoomable, pannable frame around one picture (an SVG image, a Mermaid diagram), with the zoom controls floating at
 * its top right.
 *
 * The picture renders at its natural size and is scaled with a transform inside a box sized to the scaled picture, so
 * the scroller's range always matches what is on screen and scrolling, or dragging, pans it. A pinch (Chromium reports
 * it as Ctrl+wheel) and Ctrl+wheel zoom around the pointer. Fit shows the whole picture and follows the pane as it
 * resizes; any other zoom is the reader's choice and stays. The zoom and the scroll offset are remembered under
 * `viewStateKey`, so switching tabs and back returns to the same view.
 */
export function PreviewZoomView({
    children,
    className,
    viewStateKey,
}: {
    /**
     * The picture at its natural size. Its rendered box is measured, so it must not size itself to the frame.
     */
    children: ReactNode;
    className?: string;
    viewStateKey: string;
}) {
    const { t } = useTranslation();
    const scrollerReference = useRef<HTMLDivElement>(null);
    const pictureReference = useRef<HTMLDivElement>(null);
    const panReference = useRef<PanStart | undefined>(undefined);
    const [zoom, setZoom] = useState<PreviewZoom>(
        () => readPreviewViewState(viewStateKey)?.pictureZoom ?? 'fit',
    );
    const [picture, setPicture] = useState(EMPTY_SIZE);
    const [viewport, setViewport] = useState(EMPTY_SIZE);
    const scale = zoom === 'fit' ? fitPreviewScale(picture, viewport, PADDING) : zoom;
    const hasPicture = picture.width > 0 && picture.height > 0;

    /**
     * Applies a zoom, keeping the picture point at `anchor` (relative to the viewport, its center by default) in place.
     * The render is flushed first so the scroll range already fits the new scale when the offset is set.
     */
    const zoomTo = (next: PreviewZoom, anchor?: { x: number; y: number }) => {
        const scroller = scrollerReference.current;
        if (!scroller) return;
        const nextScale = next === 'fit' ? fitPreviewScale(picture, viewport, PADDING) : next;
        const pointer = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 };
        const axis = (scroll: number, at: number, length: number, natural: number) =>
            anchoredScrollOffset({
                scroll,
                pointer: at,
                viewport: length,
                picture: natural,
                padding: PADDING,
                scale,
                nextScale,
            });
        const left = axis(scroller.scrollLeft, pointer.x, viewport.width, picture.width);
        const top = axis(scroller.scrollTop, pointer.y, viewport.height, picture.height);
        flushSync(() => setZoom(next));
        scroller.scrollLeft = left;
        scroller.scrollTop = top;
        rememberPreviewViewState(viewStateKey, { pictureZoom: next });
    };
    const latest = useLatestReference({ scale, zoomTo });

    /**
     * Tracks the picture's natural size (a diagram re-lays out as its source is edited) and the viewport's, which Fit
     * follows.
     */
    useLayoutEffect(() => {
        const scroller = scrollerReference.current;
        const content = pictureReference.current;
        if (!scroller || !content) return;
        const measure = () => {
            // `offsetWidth` is the untransformed box, so it stays the natural size whatever the zoom.
            setPicture({ width: content.offsetWidth, height: content.offsetHeight });
            setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(scroller);
        observer.observe(content);
        return () => observer.disconnect();
    }, []);

    /**
     * Restores the remembered scroll offset once the picture has a size; before that the scroll range is empty and an
     * offset set then would be clamped to zero.
     */
    const isRestoredReference = useRef(false);
    useLayoutEffect(() => {
        const scroller = scrollerReference.current;
        if (!scroller || !hasPicture || isRestoredReference.current) return;
        isRestoredReference.current = true;
        const remembered = readPreviewViewState(viewStateKey);
        scroller.scrollLeft = remembered?.scrollLeft ?? 0;
        scroller.scrollTop = remembered?.scrollTop ?? 0;
    }, [hasPicture, viewStateKey]);

    /**
     * Not a React `onWheel`: React registers wheel listeners as passive, and the pinch has to cancel the browser's own
     * scroll.
     */
    useEffect(() => {
        const scroller = scrollerReference.current;
        if (!scroller) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            const bounds = scroller.getBoundingClientRect();
            const { scale: current, zoomTo: apply } = latest.current;
            apply(clampPreviewScale(current * pinchScaleFactor(event.deltaY)), {
                x: event.clientX - bounds.left,
                y: event.clientY - bounds.top,
            });
        };
        scroller.addEventListener('wheel', onWheel, { passive: false });
        return () => scroller.removeEventListener('wheel', onWheel);
    }, [latest]);

    return (
        <div className={cn('relative min-h-0 flex-1', className)}>
            <div
                ref={scrollerReference}
                className="absolute inset-0 cursor-grab overflow-auto outline-none select-none active:cursor-grabbing"
                data-testid="preview-zoom-view"
                // Focusable so the arrow keys and Page Up/Down pan the picture.
                tabIndex={0}
                onLostPointerCapture={() => {
                    panReference.current = undefined;
                }}
                onPointerDown={(event) => {
                    const scroller = event.currentTarget;
                    const bounds = scroller.getBoundingClientRect();
                    // A press on a scrollbar belongs to the scrollbar; only the picture area pans.
                    const isOnScrollbar =
                        event.clientX - bounds.left >= scroller.clientWidth ||
                        event.clientY - bounds.top >= scroller.clientHeight;
                    if (isOnScrollbar || event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    panReference.current = {
                        pointerId: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        left: event.currentTarget.scrollLeft,
                        top: event.currentTarget.scrollTop,
                    };
                }}
                onPointerMove={(event) => {
                    const start = panReference.current;
                    if (start?.pointerId !== event.pointerId) return;
                    event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
                    event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
                }}
                onPointerUp={() => {
                    panReference.current = undefined;
                }}
                onScroll={(event) =>
                    rememberPreviewViewState(viewStateKey, {
                        scrollLeft: event.currentTarget.scrollLeft,
                        scrollTop: event.currentTarget.scrollTop,
                    })
                }
            >
                {/* Centers a picture smaller than the pane and grows with a larger one, so every edge stays reachable. */}
                <div
                    className="flex min-h-full w-max min-w-full items-center justify-center"
                    style={{ padding: PADDING }}
                >
                    <div
                        className="relative flex-none"
                        style={{ width: picture.width * scale, height: picture.height * scale }}
                    >
                        <div
                            ref={pictureReference}
                            className={cn(
                                'absolute top-0 left-0 w-max origin-top-left',
                                // Hidden until measured, so the first frame never flashes the picture at the wrong scale.
                                !hasPicture && 'invisible',
                            )}
                            style={{ transform: `scale(${scale})` }}
                        >
                            {children}
                        </div>
                    </div>
                </div>
            </div>
            <div className="absolute top-2 right-4 z-10 flex items-center gap-0.5 rounded border border-border bg-surface p-0.5 text-muted shadow-lg">
                <ZoomControls
                    checked={PREVIEW_ZOOM_CHOICES.find((choice) => choice === zoom)}
                    choiceLabel={(choice) => previewZoomLabel(choice, t)}
                    choices={PREVIEW_ZOOM_CHOICES}
                    scale={scale}
                    onZoom={(choice) => zoomTo(choice)}
                    onZoomIn={() => zoomTo(stepPreviewScale(scale, 'in'))}
                    onZoomOut={() => zoomTo(stepPreviewScale(scale, 'out'))}
                />
            </div>
        </div>
    );
}
