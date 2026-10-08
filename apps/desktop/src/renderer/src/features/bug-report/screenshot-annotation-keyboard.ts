/**
 * The keyboard path for marking an area of the Bug Report screenshot.
 *
 * Annotating used to be pointer-only: the overlay's accessible name was literally "Drag to mark an area", so a user who
 * cannot drag could file a report but could never point at the thing they were reporting. This module is the missing
 * half: it turns key presses into the same `AnnotationSegment` a drag produces, so both input paths commit through one
 * code path and the exported JPEG cannot tell them apart.
 *
 * ## Interaction model
 *
 * The overlay is a single Tab stop (`role="application"`, so the platform hands it the arrow keys instead of scrolling
 * the dialog). Inside it, one gesture is mirrored key for key from the pointer gesture it replaces: press at an anchor,
 * move to size, release to commit.
 *
 * | Key                    | No cursor yet                  | Cursor placed, no shape      | Shape in progress                    |
 * | ---------------------- | ------------------------------ | ---------------------------- | ------------------------------------ |
 * | Arrow                  | shows the cursor, centred      | moves the cursor             | moves the free corner (sizes it)     |
 * | `Shift` + Arrow        | shows the cursor, centred      | moves the cursor, fast       | sizes it, fast                       |
 * | `Option` + Arrow       | shows the cursor, centred      | moves the cursor             | moves the whole shape, size kept     |
 * | `Enter` / `Space`      | starts a shape, centred        | starts a shape at the cursor | commits it                           |
 * | `Escape`               | not handled: closes the dialog | hides the cursor             | discards the shape, keeps the cursor |
 * | `Delete` / `Backspace` | deletes the selected mark      | deletes the selected mark    | discards the shape                   |
 *
 * Three decisions are worth stating, because each one is a trade-off rather than an obvious default:
 *
 * - **Arrows size, `Option` + arrows move.** A zero-size shape has just been anchored, so sizing is the only useful next
 *   action and it gets the unmodified key; this is also the literal equivalent of the drag it replaces. `Option` is the
 *   macOS "change what this drag means" modifier, and `Shift` stays free for the conventional long-nudge multiplier
 *   rather than being spent on a mode.
 * - **`Escape` only escalates.** It is reported as unhandled while nothing is in progress, which lets it reach the dialog
 *   and close the annotator. With a shape or a cursor on screen it is consumed instead, so a keyboard user is never one
 *   reflexive keystroke away from throwing the whole editing session away.
 * - **Steps are CSS pixels, converted here.** Every stored coordinate is a natural image pixel, and a Retina capture is
 *   two or three of those per pixel the user sees. Scaling the step keeps one press worth the same visible distance on
 *   any capture instead of crawling across a 4K screenshot.
 *
 * Geometry and state math live in this `.ts` module rather than in the component so they can be unit tested; `.tsx`
 * files are not unit tested in this repository.
 */

import { clamp } from 'es-toolkit';

import type {
    AnnotationPoint,
    AnnotationSegment,
    ScreenshotAnnotationKind,
} from './screenshot-annotations';
import { isNegligibleDrag, MAX_ANNOTATIONS, normalizeBox } from './screenshot-annotations';

/**
 * How far one arrow key travels, in displayed CSS pixels. Small enough to land on a toolbar button, large enough that
 * sizing a shape over a window capture stays a handful of presses rather than a hundred.
 */
export const ANNOTATION_KEYBOARD_STEP = 8;

/**
 * The `Shift` multiplier's result, also in displayed CSS pixels: roughly one press per list row or sidebar width, for
 * crossing the capture rather than aiming inside it.
 */
export const ANNOTATION_KEYBOARD_FAST_STEP = 40;

/**
 * Where the keyboard is currently pointing. Both fields are undefined at rest, which is what makes the overlay inert
 * for a pointer user: nothing is drawn and `Escape` still belongs to the dialog.
 */
export interface AnnotationKeyboardState {
    /**
     * The fixed corner (box) or tail (arrow) of the shape being drawn. Set only while a shape is in progress.
     */
    anchor: AnnotationPoint | undefined;
    /**
     * The moving point, in natural image pixels. `undefined` means the keyboard path has not been started yet.
     */
    cursor: AnnotationPoint | undefined;
}

export const EMPTY_ANNOTATION_KEYBOARD_STATE: AnnotationKeyboardState = Object.freeze({
    anchor: undefined,
    cursor: undefined,
});

/**
 * The subset of a keyboard event this module reads, so the rules can be tested without synthesizing a React event.
 */
export interface AnnotationKeyboardInput {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
}

export interface AnnotationKeyboardContext {
    /**
     * Natural image height in pixels. Together with {@link AnnotationKeyboardContext.width} it is the clamp box: the
     * cursor and both corners of a shape stay inside the screenshot, because a mark outside it cannot be rasterized.
     */
    height: number;
    /**
     * Whether an existing mark is selected, which decides whether `Delete` has anything to act on.
     */
    hasSelection: boolean;
    /**
     * The active tool, so announcements name the shape the user is actually drawing.
     */
    kind: ScreenshotAnnotationKind;
    /**
     * How many marks the report already carries, so the limit is refused at commit time with a readable reason rather
     * than silently swallowing the shape the user just built.
     */
    markCount: number;
    /**
     * Image pixels per displayed CSS pixel, from the overlay's resize observer.
     */
    scale: number;
    width: number;
}

export interface AnnotationKeyboardOutcome {
    /**
     * A finished shape the caller must add as a new annotation, using the active tool.
     */
    commit: AnnotationSegment | undefined;
    /**
     * Whether the overlay owns this key press. Only a handled press is suppressed and kept from the dialog.
     */
    handled: boolean;
    /**
     * Polite live-region text describing what just happened, or `undefined` to leave the previous announcement alone.
     */
    message: string | undefined;
    /**
     * Whether the press deletes the currently selected mark.
     */
    removeSelected: boolean;
    state: AnnotationKeyboardState;
}

const UNHANDLED: Omit<AnnotationKeyboardOutcome, 'state'> = {
    commit: undefined,
    handled: false,
    message: undefined,
    removeSelected: false,
};

function ignore(state: AnnotationKeyboardState): AnnotationKeyboardOutcome {
    return { ...UNHANDLED, state };
}

function handle(
    state: AnnotationKeyboardState,
    message: string | undefined,
    commit?: AnnotationSegment,
): AnnotationKeyboardOutcome {
    return { commit, handled: true, message, removeSelected: false, state };
}

function directionFor(key: string): AnnotationPoint | undefined {
    switch (key) {
        case 'ArrowDown': {
            return { x: 0, y: 1 };
        }
        case 'ArrowLeft': {
            return { x: -1, y: 0 };
        }
        case 'ArrowRight': {
            return { x: 1, y: 0 };
        }
        case 'ArrowUp': {
            return { x: 0, y: -1 };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * One key press in natural image pixels. Rounded so a state that starts on whole pixels stays on whole pixels, and
 * floored at 1 so an overlay displayed larger than the capture still moves.
 */
export function annotationKeyboardStep(scale: number, isFast: boolean): number {
    const base = isFast ? ANNOTATION_KEYBOARD_FAST_STEP : ANNOTATION_KEYBOARD_STEP;
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return Math.max(1, Math.round(base * factor));
}

/**
 * The shape currently being drawn by the keyboard, in the same form a drag produces, or `undefined` when there is none.
 */
export function annotationKeyboardDraft(
    state: AnnotationKeyboardState,
): AnnotationSegment | undefined {
    if (!state.anchor || !state.cursor) return undefined;
    return { x1: state.anchor.x, x2: state.cursor.x, y1: state.anchor.y, y2: state.cursor.y };
}

function formatPoint(point: AnnotationPoint): string {
    return `x ${Math.round(point.x)}, y ${Math.round(point.y)}`;
}

/**
 * How a shape is read aloud. A box reports the area it covers, an arrow reports both of its ends, because those are the
 * two things the badge number cannot convey on its own.
 */
export function describeAnnotationSegment(
    segment: AnnotationSegment,
    kind: ScreenshotAnnotationKind,
): string {
    if (kind === 'arrow')
        return `Arrow from ${formatPoint({ x: segment.x1, y: segment.y1 })} to ${formatPoint({ x: segment.x2, y: segment.y2 })}`;
    const box = normalizeBox(segment);
    return `Box ${Math.round(box.width)} by ${Math.round(box.height)} pixels at ${formatPoint(box)}`;
}

/**
 * The overlay's accessible description: what this control is for, and the whole keyboard gesture in one sentence a
 * screen reader reads on focus. The accessible name stays the control's identity; the instructions belong here so the
 * name does not turn back into a how-to.
 */
export function annotationCanvasDescription(
    kind: ScreenshotAnnotationKind,
    markCount: number,
): string {
    const marks = markCount === 1 ? '1 mark' : `${markCount} marks`;
    const shape = kind === 'arrow' ? 'an arrow' : 'a box';
    return `${kind === 'arrow' ? 'Arrow' : 'Box'} tool, ${marks}. Press Enter to start ${shape} at the keyboard cursor, arrow keys to size it, Option and arrow keys to move it, Enter again to add it, Escape to discard it. Hold Shift to move further. Press Delete to remove the selected mark.`;
}

function centerOf(context: AnnotationKeyboardContext): AnnotationPoint {
    return { x: Math.round(context.width / 2), y: Math.round(context.height / 2) };
}

function movePoint(
    point: AnnotationPoint,
    direction: AnnotationPoint,
    step: number,
    context: AnnotationKeyboardContext,
): AnnotationPoint {
    return {
        x: clamp(point.x + direction.x * step, 0, context.width),
        y: clamp(point.y + direction.y * step, 0, context.height),
    };
}

/**
 * Slides an in-progress shape without resizing it, by clamping the offset to what the shape's own bounding box can
 * still travel. Clamping the two corners independently would squash the shape against the edge instead.
 */
function translateShape(
    state: AnnotationKeyboardState & { anchor: AnnotationPoint; cursor: AnnotationPoint },
    direction: AnnotationPoint,
    step: number,
    context: AnnotationKeyboardContext,
): AnnotationKeyboardState {
    const offset = {
        x: clamp(
            direction.x * step,
            -Math.min(state.anchor.x, state.cursor.x),
            context.width - Math.max(state.anchor.x, state.cursor.x),
        ),
        y: clamp(
            direction.y * step,
            -Math.min(state.anchor.y, state.cursor.y),
            context.height - Math.max(state.anchor.y, state.cursor.y),
        ),
    };
    return {
        anchor: { x: state.anchor.x + offset.x, y: state.anchor.y + offset.y },
        cursor: { x: state.cursor.x + offset.x, y: state.cursor.y + offset.y },
    };
}

function resolveArrowKey(
    state: AnnotationKeyboardState,
    direction: AnnotationPoint,
    input: AnnotationKeyboardInput,
    context: AnnotationKeyboardContext,
): AnnotationKeyboardOutcome {
    // The first arrow only reveals where the cursor starts. Moving it in the same press would leave the user guessing
    // which of the two positions they are now on.
    if (!state.cursor) {
        const cursor = centerOf(context);
        return handle({ anchor: undefined, cursor }, `Cursor at ${formatPoint(cursor)}.`);
    }
    const step = annotationKeyboardStep(context.scale, input.shiftKey);
    if (!state.anchor) {
        const cursor = movePoint(state.cursor, direction, step, context);
        return handle({ anchor: undefined, cursor }, `Cursor at ${formatPoint(cursor)}.`);
    }
    const next = input.altKey
        ? translateShape({ anchor: state.anchor, cursor: state.cursor }, direction, step, context)
        : { anchor: state.anchor, cursor: movePoint(state.cursor, direction, step, context) };
    const draft = annotationKeyboardDraft(next);
    return handle(next, draft && `${describeAnnotationSegment(draft, context.kind)}.`);
}

function resolveCommitKey(
    state: AnnotationKeyboardState,
    context: AnnotationKeyboardContext,
): AnnotationKeyboardOutcome {
    const draft = annotationKeyboardDraft(state);
    if (!draft) {
        const cursor = state.cursor ?? centerOf(context);
        return handle(
            { anchor: cursor, cursor },
            `${context.kind === 'arrow' ? 'Arrow' : 'Box'} started at ${formatPoint(cursor)}.`,
        );
    }
    const shape = context.kind === 'arrow' ? 'arrow' : 'box';
    if (context.markCount >= MAX_ANNOTATIONS)
        return handle(
            state,
            `Up to ${MAX_ANNOTATIONS} marks. Delete one before adding another ${shape}.`,
        );
    // The same size floor the pointer path uses, so a shape nobody could see is never added by either input.
    if (isNegligibleDrag({ ...draft, kind: context.kind }))
        return handle(
            state,
            `This ${shape} is too small to add. Press the arrow keys to make it bigger.`,
        );
    // The cursor survives the commit so the next mark starts where the last one ended.
    return handle(
        { anchor: undefined, cursor: state.cursor },
        `Added ${describeAnnotationSegment(draft, context.kind).toLowerCase()}.`,
        draft,
    );
}

/**
 * Turns one key press on the annotation overlay into the next keyboard state plus whatever the caller has to do about
 * it. Pure, so the component only has to store the returned state and forward `commit` to the annotator.
 */
export function resolveAnnotationKey(
    state: AnnotationKeyboardState,
    input: AnnotationKeyboardInput,
    context: AnnotationKeyboardContext,
): AnnotationKeyboardOutcome {
    // Command and Control belong to the application's own shortcuts; the overlay never competes for them.
    if (input.metaKey || input.ctrlKey) return ignore(state);

    const direction = directionFor(input.key);
    if (direction) return resolveArrowKey(state, direction, input, context);

    if (input.key === 'Enter' || input.key === ' ') return resolveCommitKey(state, context);

    const shape = context.kind === 'arrow' ? 'Arrow' : 'Box';
    if (input.key === 'Escape') {
        if (state.anchor)
            return handle({ anchor: undefined, cursor: state.cursor }, `${shape} discarded.`);
        if (state.cursor) return handle(EMPTY_ANNOTATION_KEYBOARD_STATE, 'Keyboard cursor hidden.');
        // Nothing of ours is on screen, so Escape is the dialog's: closing the annotator is what the user meant.
        return ignore(state);
    }

    if (input.key === 'Delete' || input.key === 'Backspace') {
        if (state.anchor)
            return handle({ anchor: undefined, cursor: state.cursor }, `${shape} discarded.`);
        if (!context.hasSelection) return ignore(state);
        return {
            commit: undefined,
            handled: true,
            message: 'Deleted the selected mark.',
            removeSelected: true,
            state,
        };
    }

    return ignore(state);
}
