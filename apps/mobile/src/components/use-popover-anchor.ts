import type { RefObject } from 'react';
import { useCallback, useState } from 'react';
import type { HostInstance } from 'react-native';
import { useWindowDimensions } from 'react-native';

/**
 * A popover's window position: `top` opens it under its anchor, `bottom` above it (for an anchor near the screen's
 * bottom edge, such as a floating toolbar).
 */
export type PopoverPlacement = { right: number } & ({ bottom: number } | { top: number });

/**
 * Opens a popover under an anchor view. The anchor's window position is measured at open time because the menu renders
 * in its own modal window, outside the anchor's layout.
 */
export const usePopoverAnchor = (
    anchor: RefObject<HostInstance | null>,
    { side = 'below' }: { side?: 'above' | 'below' } = {},
) => {
    const { height, width } = useWindowDimensions();
    const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
    const open = useCallback((): void => {
        anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
            const right = Math.max(8, width - x - anchorWidth);
            setPlacement(
                side === 'above'
                    ? { bottom: height - y + 8, right }
                    : { right, top: y + anchorHeight },
            );
        });
    }, [anchor, height, side, width]);
    const close = useCallback((): void => setPlacement(null), []);
    return { close, isOpen: placement !== null, open, placement };
};
