import { useEffect, useState } from 'react';

import { sidebarDetailCardDismissal } from '../sidebar-detail-card-dismissal';
import {
    claimSidebarDetailCard,
    isSidebarDetailCardWarm,
    sidebarDetailCardMotionClassName,
    useSidebarDetailCardDelay,
} from '../sidebar-detail-card-handoff';

/**
 * The open state of the Session hover card (PrimarySidebar and Activity rows): Escape and modal dismissal, the
 * one-card- at-a-time handoff that lets a hover sweep swap cards at once, and the delay and motion classes that handoff
 * picks. Only the Session card is fast on purpose: the Project heading's card keeps the ordinary hover-card delay and
 * motion. `suppressed` hides the card without forgetting it was asked for (an open row menu).
 */
export function useSidebarDetailCard(suppressed: boolean | undefined) {
    const [open, setOpenState] = useState(false);
    const [isOpenedWarm, setOpenedWarm] = useState(false);
    const delay = useSidebarDetailCardDelay();
    const visible = open && !suppressed;

    useEffect(() => {
        if (!visible) return;
        const release = claimSidebarDetailCard(() => setOpenState(false));
        const dismiss = sidebarDetailCardDismissal(() => setOpenState(false));
        return () => {
            dismiss();
            release();
        };
    }, [visible]);

    const setOpen = (isNextOpen: boolean): void => {
        // Read when the card opens, before its own claim warms the list, so only a card that follows another skips its
        // enter animation.
        if (isNextOpen && !open) setOpenedWarm(isSidebarDetailCardWarm());
        setOpenState(isNextOpen);
    };

    return {
        closeDelay: 80,
        delay,
        motionClassName: sidebarDetailCardMotionClassName(isOpenedWarm),
        setOpen,
        visible,
    };
}
