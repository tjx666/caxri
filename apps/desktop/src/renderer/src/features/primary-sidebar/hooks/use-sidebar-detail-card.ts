import { useEffect, useState } from 'react';
// react-doctor-disable-next-line react-doctor/no-flush-sync -- the hover delay must be committed before Base UI's native mouseenter reads it.
import { flushSync } from 'react-dom';

import { sidebarDetailCardDismissal } from '../sidebar-detail-card-dismissal';
import {
    claimSidebarDetailCard,
    isSidebarDetailCardWarm,
    SIDEBAR_DETAIL_CARD_DELAY_MS,
    sidebarDetailCardDelay,
    sidebarDetailCardMotionClassName,
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
    const [delay, setDelay] = useState(SIDEBAR_DETAIL_CARD_DELAY_MS);
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

    /**
     * Picks the hover delay for this entry, before Base UI's own mouseenter reads it. The hand-off flag is read here
     * instead of subscribed to, so only the row the pointer enters re-renders. Base UI reads the delay at its native
     * `mouseenter`, which follows `pointerenter` within the same pointer move; `flushSync` commits the new delay in
     * between instead of leaving it to a later task.
     */
    const onPointerEnter = (): void => {
        const nextDelay = sidebarDetailCardDelay();
        if (nextDelay === delay) return;
        flushSync(() => setDelay(nextDelay));
    };

    return {
        closeDelay: 80,
        delay,
        motionClassName: sidebarDetailCardMotionClassName(isOpenedWarm),
        onPointerEnter,
        setOpen,
        visible,
    };
}
