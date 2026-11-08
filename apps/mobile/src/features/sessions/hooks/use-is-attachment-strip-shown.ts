import { useEffect, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';

import { IMAGE_STRIP_EXIT_MS } from '../image-strip-layout';

/**
 * Whether the composer still shows its attachment strip: at once when an attachment arrives, and until the last removed
 * one has faded out after the strip empties. The composer keeps its expanded layout for that long, so removing the last
 * attachment fades the card where it sat instead of folding the composer away beneath a card still on screen. Reduced
 * motion skips the fade, so the strip leaves at once.
 */
export const useIsAttachmentStripShown = (hasAttachments: boolean): boolean => {
    const isReducedMotion = useReducedMotion();
    const [isLeaving, setLeaving] = useState(false);
    const [wasShown, setWasShown] = useState(hasAttachments);
    // A strip that just emptied starts leaving during render, so no frame shows the composer folded early.
    if (wasShown !== hasAttachments) {
        setWasShown(hasAttachments);
        setLeaving(!hasAttachments && !isReducedMotion);
    }
    useEffect(() => {
        if (!isLeaving) return;
        const timer = setTimeout(() => setLeaving(false), IMAGE_STRIP_EXIT_MS);
        return () => clearTimeout(timer);
    }, [isLeaving]);
    return hasAttachments || isLeaving;
};
