import { useCallback, useState } from 'react';

import { BUG_REPORT_JPEG_DATA_URL_PREFIX } from '@caxri/protocol';

import { translate } from '../../i18n';
import type {
    AnnotationSegment,
    ScreenshotAnnotation,
    ScreenshotAnnotationKind,
} from './screenshot-annotations';
import { drawAnnotations, MAX_ANNOTATIONS } from './screenshot-annotations';

/**
 * JPEG quality for the annotated rasterization. The capture the Server hands us is already JPEG, so re-encoding at a
 * higher quality would only grow the payload the Agent has to swallow without recovering detail.
 */
const ANNOTATED_JPEG_QUALITY = 0.85;

function loadImage(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image));
        image.addEventListener('error', () =>
            reject(new Error(translate('bugReport.annotator.readFailed'))),
        );
        image.src = source;
    });
}

/**
 * Editing state for the annotation editor: the marks themselves, the active tool, the selection, and the display scale
 * the overlay and the rasterizer share. Kept out of the components so the flow stays reviewable in one place: the
 * components below it only translate pointer events into these calls.
 */
export function useScreenshotAnnotator(initialAnnotations: readonly ScreenshotAnnotation[]) {
    const [annotations, setAnnotations] = useState<ScreenshotAnnotation[]>(() => [
        ...initialAnnotations,
    ]);
    const [tool, setTool] = useState<ScreenshotAnnotationKind>('box');
    const [selectedId, setSelectedId] = useState<string>();
    const [focusAnnotationId, setFocusAnnotationId] = useState<string>();
    /**
     * Image pixels per displayed CSS pixel. The overlay draws in image coordinates, so strokes, arrow heads, and badges
     * have to be multiplied by this to stay the same physical size the user drew at, and the rasterizer reuses it so
     * the exported file matches the preview.
     */
    const [displayScale, setDisplayScale] = useState(1);

    const isAtLimit = annotations.length >= MAX_ANNOTATIONS;

    /**
     * Drags past {@link MAX_ANNOTATIONS} are dropped rather than queued: the report the Agent receives is capped at 48
     * KiB (`bugReportText`), and every mark costs a numbered line plus its note.
     */
    const addAnnotation = (segment: AnnotationSegment): void => {
        if (isAtLimit) return;
        const annotation: ScreenshotAnnotation = {
            ...segment,
            id: crypto.randomUUID(),
            kind: tool,
            note: '',
        };
        setAnnotations((current) => [...current, annotation]);
        setSelectedId(annotation.id);
        // A mark with no note is only half a bug report, so the matching textarea takes focus immediately.
        setFocusAnnotationId(annotation.id);
    };

    const removeAnnotation = (id: string): void => {
        setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
        setSelectedId((current) => (current === id ? undefined : current));
    };

    const removeSelectedAnnotation = (): void => {
        if (selectedId) removeAnnotation(selectedId);
    };

    const updateNote = (id: string, note: string): void => {
        setAnnotations((current) =>
            current.map((annotation) =>
                annotation.id === id ? { ...annotation, note } : annotation,
            ),
        );
    };

    /**
     * Stable so the note row's focus effect does not re-run on every parent render.
     */
    const clearFocusRequest = useCallback(() => setFocusAnnotationId(undefined), []);

    /**
     * Redraws the original capture at natural size with the marks burned in. Returns `undefined` only when there is
     * nothing to burn in, which keeps the caller on the untouched original instead of a needless re-encode.
     *
     * Every other failure throws instead of returning `undefined`, because the two results are not interchangeable to
     * the caller: `undefined` means "the marks are committed and the original image is correct", so a silent failure
     * here would hand the Agent an unmarked screenshot alongside notes describing marks it cannot see. Throwing keeps
     * `finish()` on its render-error path with the editor open.
     */
    const rasterize = async (source: string): Promise<string | undefined> => {
        if (annotations.length === 0) return undefined;
        const image = await loadImage(source);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error(translate('bugReport.annotator.canvasFailed'));
        context.drawImage(image, 0, 0);
        drawAnnotations(context, annotations, displayScale);
        const dataUrl = canvas.toDataURL('image/jpeg', ANNOTATED_JPEG_QUALITY);
        // A canvas that cannot encode JPEG falls back to PNG, which the screenshot contract rejects downstream.
        if (!dataUrl.startsWith(BUG_REPORT_JPEG_DATA_URL_PREFIX))
            throw new Error(translate('bugReport.annotator.encodeFailed'));
        return dataUrl;
    };

    return {
        addAnnotation,
        annotations,
        clearFocusRequest,
        displayScale,
        focusAnnotationId,
        isAtLimit,
        rasterize,
        removeAnnotation,
        removeSelectedAnnotation,
        selectAnnotation: setSelectedId,
        selectedId,
        setDisplayScale,
        setTool,
        tool,
        updateNote,
    };
}
