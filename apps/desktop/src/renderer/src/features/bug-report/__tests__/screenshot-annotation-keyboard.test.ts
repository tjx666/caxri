import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import type {
    AnnotationKeyboardContext,
    AnnotationKeyboardInput,
    AnnotationKeyboardState,
} from '../screenshot-annotation-keyboard';
import {
    ANNOTATION_KEYBOARD_FAST_STEP,
    ANNOTATION_KEYBOARD_STEP,
    annotationCanvasDescription,
    annotationKeyboardDraft,
    annotationKeyboardStep,
    describeAnnotationSegment,
    EMPTY_ANNOTATION_KEYBOARD_STATE,
    resolveAnnotationKey,
} from '../screenshot-annotation-keyboard';
import { MAX_ANNOTATIONS } from '../screenshot-annotations';

/**
 * A 1000x600 capture displayed at natural size, so one arrow key is exactly {@link ANNOTATION_KEYBOARD_STEP} image
 * pixels and every expectation below can be written as a literal coordinate.
 */
function context(overrides: Partial<AnnotationKeyboardContext> = {}): AnnotationKeyboardContext {
    return {
        hasSelection: false,
        height: 600,
        kind: 'box',
        markCount: 0,
        scale: 1,
        width: 1000,
        ...overrides,
    };
}

function press(key: string, modifiers: Partial<AnnotationKeyboardInput> = {}) {
    return { altKey: false, ctrlKey: false, key, metaKey: false, shiftKey: false, ...modifiers };
}

function drawing(anchor: [number, number], cursor: [number, number]): AnnotationKeyboardState {
    return {
        anchor: { x: anchor[0], y: anchor[1] },
        cursor: { x: cursor[0], y: cursor[1] },
    };
}

function pointing(cursor: [number, number]): AnnotationKeyboardState {
    return { anchor: undefined, cursor: { x: cursor[0], y: cursor[1] } };
}

describe('annotationKeyboardStep', () => {
    it('converts CSS pixels to the capture s own pixels so one press feels the same on a Retina screenshot', () => {
        expect(annotationKeyboardStep(1, false)).toBe(ANNOTATION_KEYBOARD_STEP);
        expect(annotationKeyboardStep(2, false)).toBe(ANNOTATION_KEYBOARD_STEP * 2);
        expect(annotationKeyboardStep(2, true)).toBe(ANNOTATION_KEYBOARD_FAST_STEP * 2);
    });

    it('never stalls on a degenerate or oversized display scale', () => {
        expect(annotationKeyboardStep(0, false)).toBe(ANNOTATION_KEYBOARD_STEP);
        expect(annotationKeyboardStep(NaN, false)).toBe(ANNOTATION_KEYBOARD_STEP);
        expect(annotationKeyboardStep(0.01, false)).toBe(1);
    });
});

describe('starting the keyboard path', () => {
    it('shows the cursor at the centre on the first arrow, without also moving it', () => {
        const outcome = resolveAnnotationKey(
            EMPTY_ANNOTATION_KEYBOARD_STATE,
            press('ArrowRight'),
            context(),
        );
        expect(outcome.handled).toBe(true);
        expect(outcome.state.cursor).toEqual({ x: 500, y: 300 });
        expect(outcome.state.anchor).toBeUndefined();
        expect(outcome.message).toBe('Cursor at x 500, y 300.');
    });

    it('starts a shape at the centre when Enter arrives before any arrow', () => {
        const outcome = resolveAnnotationKey(
            EMPTY_ANNOTATION_KEYBOARD_STATE,
            press('Enter'),
            context(),
        );
        expect(outcome.state).toEqual(drawing([500, 300], [500, 300]));
        expect(outcome.message).toBe('Box started at x 500, y 300.');
        expect(outcome.commit).toBeUndefined();
    });

    it('names the tool it is about to draw', () => {
        const outcome = resolveAnnotationKey(
            pointing([100, 100]),
            press(' '),
            context({ kind: 'arrow' }),
        );
        expect(outcome.state).toEqual(drawing([100, 100], [100, 100]));
        expect(outcome.message).toBe('Arrow started at x 100, y 100.');
    });
});

describe('moving the cursor', () => {
    it('travels one step per arrow and further with Shift', () => {
        expect(
            resolveAnnotationKey(pointing([500, 300]), press('ArrowRight'), context()).state.cursor,
        ).toEqual({ x: 508, y: 300 });
        expect(
            resolveAnnotationKey(pointing([500, 300]), press('ArrowUp'), context()).state.cursor,
        ).toEqual({ x: 500, y: 292 });
        expect(
            resolveAnnotationKey(
                pointing([500, 300]),
                press('ArrowDown', { shiftKey: true }),
                context(),
            ).state.cursor,
        ).toEqual({ x: 500, y: 340 });
    });

    it('stops at the edges of the capture instead of leaving it', () => {
        expect(
            resolveAnnotationKey(pointing([4, 2]), press('ArrowLeft'), context()).state.cursor,
        ).toEqual({ x: 0, y: 2 });
        expect(
            resolveAnnotationKey(pointing([996, 598]), press('ArrowDown'), context()).state.cursor,
        ).toEqual({ x: 996, y: 600 });
        expect(
            resolveAnnotationKey(
                pointing([996, 598]),
                press('ArrowRight', { shiftKey: true }),
                context(),
            ).state.cursor,
        ).toEqual({ x: 1000, y: 598 });
    });
});

describe('sizing a shape', () => {
    it('moves the free corner and leaves the anchor where the user put it', () => {
        const outcome = resolveAnnotationKey(
            drawing([500, 300], [500, 300]),
            press('ArrowRight'),
            context(),
        );
        expect(outcome.state).toEqual(drawing([500, 300], [508, 300]));
        expect(outcome.message).toBe('Box 8 by 0 pixels at x 500, y 300.');
    });

    it('reads an arrow out as its two ends rather than as an area', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [140, 100]),
            press('ArrowDown'),
            context({ kind: 'arrow' }),
        );
        expect(outcome.message).toBe('Arrow from x 100, y 100 to x 140, y 108.');
    });

    it('sizes backwards past the anchor, the way a right-to-left drag does', () => {
        const outcome = resolveAnnotationKey(
            drawing([500, 300], [480, 260]),
            press('ArrowLeft'),
            context(),
        );
        expect(outcome.state).toEqual(drawing([500, 300], [472, 260]));
        expect(outcome.message).toBe('Box 28 by 40 pixels at x 472, y 260.');
    });

    it('clamps the free corner to the capture', () => {
        expect(
            resolveAnnotationKey(drawing([900, 300], [998, 300]), press('ArrowRight'), context())
                .state.cursor,
        ).toEqual({ x: 1000, y: 300 });
    });
});

describe('moving a whole shape with Option', () => {
    it('keeps the size while both corners travel', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [200, 160]),
            press('ArrowRight', { altKey: true }),
            context(),
        );
        expect(outcome.state).toEqual(drawing([108, 100], [208, 160]));
        expect(outcome.message).toBe('Box 100 by 60 pixels at x 108, y 100.');
    });

    it('stops the shape at the edge without squashing it', () => {
        const outcome = resolveAnnotationKey(
            drawing([900, 100], [996, 160]),
            press('ArrowRight', { shiftKey: true, altKey: true }),
            context(),
        );
        expect(outcome.state).toEqual(drawing([904, 100], [1000, 160]));
        expect(annotationKeyboardDraft(outcome.state)).toEqual({
            x1: 904,
            x2: 1000,
            y1: 100,
            y2: 160,
        });
    });

    it('clamps by the bounding box even when the anchor is the far corner', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 200], [4, 120]),
            press('ArrowLeft', { altKey: true }),
            context(),
        );
        expect(outcome.state).toEqual(drawing([96, 200], [0, 120]));
    });
});

describe('committing', () => {
    it('hands back the finished shape and keeps the cursor for the next one', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [260, 220]),
            press('Enter'),
            context(),
        );
        expect(outcome.commit).toEqual({ x1: 100, x2: 260, y1: 100, y2: 220 });
        expect(outcome.state).toEqual(pointing([260, 220]));
        expect(outcome.message).toBe('Added box 160 by 120 pixels at x 100, y 100.');
    });

    it('refuses a shape too small to see and says how to fix it', () => {
        const state = drawing([100, 100], [102, 101]);
        const outcome = resolveAnnotationKey(state, press(' '), context());
        expect(outcome.commit).toBeUndefined();
        expect(outcome.state).toEqual(state);
        expect(outcome.message).toBe(
            'This box is too small to add. Press the arrow keys to make it bigger.',
        );
    });

    it('keeps a deliberate horizontal arrow that the box rule would reject', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [180, 100]),
            press('Enter'),
            context({ kind: 'arrow' }),
        );
        expect(outcome.commit).toEqual({ x1: 100, x2: 180, y1: 100, y2: 100 });
        expect(outcome.message).toBe('Added arrow from x 100, y 100 to x 180, y 100.');
    });

    it('refuses the mark limit with a reason instead of dropping the shape silently', () => {
        const state = drawing([100, 100], [260, 220]);
        const outcome = resolveAnnotationKey(
            state,
            press('Enter'),
            context({ markCount: MAX_ANNOTATIONS }),
        );
        expect(outcome.commit).toBeUndefined();
        expect(outcome.state).toEqual(state);
        expect(outcome.message).toBe(
            `Up to ${MAX_ANNOTATIONS} marks. Delete one before adding another box.`,
        );
    });
});

describe('cancelling', () => {
    it('discards the shape in progress but keeps the cursor', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [260, 220]),
            press('Escape'),
            context(),
        );
        expect(outcome.handled).toBe(true);
        expect(outcome.state).toEqual(pointing([260, 220]));
        expect(outcome.commit).toBeUndefined();
        expect(outcome.message).toBe('Box discarded.');
    });

    it('hides the cursor on the next Escape', () => {
        const outcome = resolveAnnotationKey(pointing([260, 220]), press('Escape'), context());
        expect(outcome.handled).toBe(true);
        expect(outcome.state).toEqual(EMPTY_ANNOTATION_KEYBOARD_STATE);
        expect(outcome.message).toBe('Keyboard cursor hidden.');
    });

    it('lets Escape reach the dialog once nothing of ours is on screen', () => {
        const outcome = resolveAnnotationKey(
            EMPTY_ANNOTATION_KEYBOARD_STATE,
            press('Escape'),
            context(),
        );
        expect(outcome.handled).toBe(false);
        expect(outcome.state).toEqual(EMPTY_ANNOTATION_KEYBOARD_STATE);
    });
});

describe('deleting', () => {
    it('removes the selected mark when nothing is being drawn', () => {
        const outcome = resolveAnnotationKey(
            pointing([260, 220]),
            press('Backspace'),
            context({ hasSelection: true }),
        );
        expect(outcome.removeSelected).toBe(true);
        expect(outcome.state).toEqual(pointing([260, 220]));
        expect(outcome.message).toBe('Deleted the selected mark.');
    });

    it('discards the shape in progress rather than a mark already on the image', () => {
        const outcome = resolveAnnotationKey(
            drawing([100, 100], [260, 220]),
            press('Delete'),
            context({ hasSelection: true }),
        );
        expect(outcome.removeSelected).toBe(false);
        expect(outcome.state).toEqual(pointing([260, 220]));
    });

    it('is not swallowed when there is nothing to delete', () => {
        expect(resolveAnnotationKey(pointing([260, 220]), press('Delete'), context()).handled).toBe(
            false,
        );
    });
});

describe('keys the overlay does not own', () => {
    it('leaves Command and Control shortcuts to the application', () => {
        for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
            const outcome = resolveAnnotationKey(
                drawing([100, 100], [260, 220]),
                press('ArrowRight', modifiers),
                context(),
            );
            expect(outcome.handled).toBe(false);
            expect(outcome.state).toEqual(drawing([100, 100], [260, 220]));
        }
    });

    it('leaves Tab alone so the overlay stays one stop in the dialog s focus order', () => {
        expect(resolveAnnotationKey(pointing([100, 100]), press('Tab'), context()).handled).toBe(
            false,
        );
    });
});

describe('what a screen reader is told', () => {
    it('describes a box by the area it covers and an arrow by its ends', () => {
        const segment = { x1: 260, x2: 100, y1: 220, y2: 100 };
        expect(describeAnnotationSegment(segment, 'box')).toBe(
            'Box 160 by 120 pixels at x 100, y 100',
        );
        expect(describeAnnotationSegment(segment, 'arrow')).toBe(
            'Arrow from x 260, y 220 to x 100, y 100',
        );
    });

    it('puts the whole gesture and the current tool in the overlay s description', () => {
        expect(annotationCanvasDescription('box', 0, translate)).toContain('Box tool, 0 marks.');
        expect(annotationCanvasDescription('arrow', 1, translate)).toContain('Arrow tool, 1 mark.');
        expect(annotationCanvasDescription('arrow', 2, translate)).toContain(
            'Press Enter to start an arrow at the keyboard cursor',
        );
        for (const phrase of ['arrow keys to size it', 'Escape to discard it', 'Hold Shift'])
            expect(annotationCanvasDescription('box', 3, translate)).toContain(phrase);
    });
});

describe('annotationKeyboardDraft', () => {
    it('is empty until both ends exist', () => {
        expect(annotationKeyboardDraft(EMPTY_ANNOTATION_KEYBOARD_STATE)).toBeUndefined();
        expect(annotationKeyboardDraft(pointing([100, 100]))).toBeUndefined();
        expect(annotationKeyboardDraft(drawing([100, 100], [260, 220]))).toEqual({
            x1: 100,
            x2: 260,
            y1: 100,
            y2: 220,
        });
    });
});
