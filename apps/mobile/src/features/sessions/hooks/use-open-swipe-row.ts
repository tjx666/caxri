import { useCallback, useRef } from 'react';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

/**
 * Tracks the one Session row whose swipe action is revealed, the way a chat list keeps at most one row open. Opening
 * another row, starting a scroll, or the next tap closes it; `closeOpen` reports whether it had anything to close so
 * that tap can be consumed instead of opening a Session.
 */
export const useOpenSwipeRow = () => {
    const openReference = useRef<SwipeableMethods | null>(null);
    const closeOpen = useCallback((): boolean => {
        const open = openReference.current;
        openReference.current = null;
        open?.close();
        return open !== null;
    }, []);
    const handleOpen = useCallback(
        (methods: SwipeableMethods): void => {
            if (openReference.current !== methods) closeOpen();
            openReference.current = methods;
        },
        [closeOpen],
    );
    const handleClose = useCallback((methods: SwipeableMethods): void => {
        if (openReference.current === methods) openReference.current = null;
    }, []);
    /**
     * An archived row unmounts without a close event, so it must be forgotten explicitly.
     */
    const forget = useCallback((): void => {
        openReference.current = null;
    }, []);
    return { closeOpen, forget, handleClose, handleOpen };
};
