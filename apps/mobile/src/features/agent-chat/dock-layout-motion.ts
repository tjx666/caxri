/**
 * Whether a docked panel's layout change is its own resize (the plan's step list or the goal's full objective opening
 * or closing) rather than a plain move. Only a resize animates: when the keyboard shows or hides, the screen shrinks
 * and every docked row moves by the keyboard's height at the same size, and the composer and the unanimated rows jump
 * there at once. A panel that animated that move would trail them for the whole transition, sliding over the composer
 * and the keyboard. A worklet, since the dock's layout transition calls it on the UI thread.
 */
export const isDockResize = (values: {
    currentHeight: number;
    currentWidth: number;
    targetHeight: number;
    targetWidth: number;
}): boolean => {
    'worklet';
    return (
        values.currentHeight !== values.targetHeight || values.currentWidth !== values.targetWidth
    );
};
