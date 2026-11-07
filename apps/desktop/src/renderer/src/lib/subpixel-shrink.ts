/**
 * How far a measured filler at the end of a scroller may fall short of its laid-out height before it shrinks; see
 * {@link isSubpixelShrink}.
 */
const SUBPIXEL_SLACK_PX = 1;

/**
 * Whether shrinking a filler from `currentHeight` to `nextHeight` is only measurement noise, so it should keep
 * `currentHeight`.
 *
 * A filler at the end of a scroller (the space Agent Chat keeps under its latest turn, the return hint's slot) that
 * shrinks to the part still at or above the view's bottom is measured on every scroll event. When the view's height is
 * fractional (a non-integer zoom, a composer of fractional height), the measured part reads a fraction short of the
 * filler actually laid out, and each such shrink snaps the content one device pixel shorter; the browser then clamps
 * the view up by that pixel and fires a scroll event that measures the same fraction short again. Unchecked, that loop
 * slid an idle view one device pixel per frame until the whole filler was gone (issues #3591 and #3734). A real scroll
 * still shrinks the filler once it moved the view a whole pixel.
 */
export function isSubpixelShrink(currentHeight: number | undefined, nextHeight: number): boolean {
    return (
        currentHeight !== undefined &&
        nextHeight < currentHeight &&
        currentHeight - nextHeight < SUBPIXEL_SLACK_PX
    );
}
