/**
 * The frame a bottom-anchored layout transition starts from: the view's current size, already sitting on its target's
 * bottom edge. Only the size then animates, growing or shrinking upward, and the view never travels.
 *
 * A plain `LinearTransition` also animates the view's position. When the keyboard shows or hides, the screen shrinks or
 * grows and every row above the composer moves by the keyboard's height; the rows without a layout transition jump
 * there at once, so an animated row trailed them for the whole transition, sliding over the composer and the keyboard.
 * A worklet, since the layout transition calls it on the UI thread.
 */
export const anchoredLayoutStart = (values: {
    currentHeight: number;
    currentWidth: number;
    targetHeight: number;
    targetOriginX: number;
    targetOriginY: number;
}): { height: number; originX: number; originY: number; width: number } => {
    'worklet';
    return {
        height: values.currentHeight,
        originX: values.targetOriginX,
        originY: values.targetOriginY + values.targetHeight - values.currentHeight,
        width: values.currentWidth,
    };
};
