import type { Transition } from 'motion/react';

import { motionDurationMs, motionEasing } from '../../../../lib/motion';

const resolved: { swap?: Transition } = {};

/**
 * One piece of the status row trading places with another: the new one rises in from a slight blur while the old one
 * lifts away. The filter is dropped once the swap settles: a leftover filter makes the text its own stacking context,
 * which the working verb's text-clipped highlight sweep cannot paint through.
 */
export const STATUS_ROW_SWAP = {
    enter: { opacity: 0, y: 6, filter: 'blur(3px)' },
    shown: { opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } },
    exit: { opacity: 0, y: -6, filter: 'blur(3px)' },
    /**
     * Resolved from the motion tokens on first use and kept: the row re-renders every second while a turn runs.
     */
    get transition(): Transition {
        resolved.swap ??= {
            duration: motionDurationMs('--motion-status-swap') / 1000,
            ease: motionEasing('--motion-ease-enter'),
        };
        return resolved.swap;
    },
};
