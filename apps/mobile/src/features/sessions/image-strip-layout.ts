/**
 * Geometry of the composer's image strip (`SessionComposerAttachments`). The remove button is a 44dp touch target, the
 * platform minimum, around a 22dp circle that overhangs its thumbnail's top right corner by 6dp. The target is centered
 * on the circle, so it reaches `IMAGE_STRIP_REMOVE_OVERHANG` past the thumbnail's top and right edges. Android delivers
 * no touch outside a parent's bounds, so each strip cell grows by that overhang toward the top and the end and holds
 * its whole target; cells sit one point apart, so a target never covers the next thumbnail or its target.
 */
export const IMAGE_STRIP_THUMBNAIL = 64;
export const IMAGE_STRIP_REMOVE_TARGET = 44;
export const IMAGE_STRIP_REMOVE_CIRCLE = 22;
const REMOVE_CIRCLE_OVERHANG = 6;
export const IMAGE_STRIP_REMOVE_OVERHANG =
    REMOVE_CIRCLE_OVERHANG + (IMAGE_STRIP_REMOVE_TARGET - IMAGE_STRIP_REMOVE_CIRCLE) / 2;
/**
 * One strip cell: a thumbnail plus room for its remove target above it and past its end.
 */
export const IMAGE_STRIP_CELL = IMAGE_STRIP_THUMBNAIL + IMAGE_STRIP_REMOVE_OVERHANG;
export const IMAGE_STRIP_CELL_GAP = 1;

export interface StripRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/**
 * The cell at `index`, in the strip's content coordinates.
 */
export const imageStripCellRect = (index: number): StripRect => {
    const left = index * (IMAGE_STRIP_CELL + IMAGE_STRIP_CELL_GAP);
    return { left, top: 0, right: left + IMAGE_STRIP_CELL, bottom: IMAGE_STRIP_CELL };
};

/**
 * Where the thumbnail at `index` sits: at the start and bottom of its cell.
 */
export const imageStripThumbnailRect = (index: number): StripRect => {
    const cell = imageStripCellRect(index);
    return {
        left: cell.left,
        top: IMAGE_STRIP_REMOVE_OVERHANG,
        right: cell.left + IMAGE_STRIP_THUMBNAIL,
        bottom: cell.bottom,
    };
};

/**
 * Where the remove target of the thumbnail at `index` sits: the top end corner of its cell.
 */
export const imageStripRemoveTargetRect = (index: number): StripRect => {
    const cell = imageStripCellRect(index);
    return {
        left: cell.right - IMAGE_STRIP_REMOVE_TARGET,
        top: 0,
        right: cell.right,
        bottom: IMAGE_STRIP_REMOVE_TARGET,
    };
};
