import type { RefObject } from 'react';
import { useCallback, useState } from 'react';
import type { HostInstance } from 'react-native';
import { useWindowDimensions } from 'react-native';

/**
 * A popover's window position: `top` opens it under its anchor, `bottom` above it (for an anchor near the screen's
 * bottom edge, such as a floating toolbar). `right` lines its end up with the anchor's, `left` its start, for an anchor
 * near the screen's start edge.
 */
export type PopoverPlacement = ({ right: number } | { left: number }) &
    ({ bottom: number } | { top: number });

/**
 * Opens a popover under an anchor view. The anchor's window position is measured at open time because the menu renders
 * in its own modal window, outside the anchor's layout. `side: 'auto'` opens it above an anchor in the screen's lower
 * half, so a menu under the last reply never runs off the bottom; `align: 'start'` lines it up with the anchor's
 * start.
 */
export const usePopoverAnchor = (
    anchor: RefObject<HostInstance | null>,
    {
        align = 'end',
        side = 'below',
    }: { align?: 'end' | 'start'; side?: 'above' | 'auto' | 'below' } = {},
) => {
    const { height, width } = useWindowDimensions();
    const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
    const open = useCallback((): void => {
        anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
            const horizontal =
                align === 'start'
                    ? { left: Math.max(8, x) }
                    : { right: Math.max(8, width - x - anchorWidth) };
            const isAbove = side === 'above' || (side === 'auto' && y > height / 2);
            setPlacement(
                isAbove
                    ? { bottom: height - y + 8, ...horizontal }
                    : { ...horizontal, top: y + anchorHeight },
            );
        });
    }, [align, anchor, height, side, width]);
    const close = useCallback((): void => setPlacement(null), []);
    return { close, isOpen: placement !== null, open, placement };
};
