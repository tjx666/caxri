import type { RefObject } from 'react';
import { useCallback, useState } from 'react';
import type { View } from 'react-native';
import { useWindowDimensions } from 'react-native';

export interface PopoverPlacement {
    right: number;
    top: number;
}

/**
 * Opens a popover under an anchor view. The anchor's window position is measured at open time because the menu renders
 * in its own modal window, outside the anchor's layout.
 */
export const usePopoverAnchor = (anchor: RefObject<View | null>) => {
    const { width } = useWindowDimensions();
    const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
    const open = useCallback((): void => {
        anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
            setPlacement({ right: Math.max(8, width - x - anchorWidth), top: y + anchorHeight });
        });
    }, [anchor, width]);
    const close = useCallback((): void => setPlacement(null), []);
    return { close, isOpen: placement !== null, open, placement };
};
