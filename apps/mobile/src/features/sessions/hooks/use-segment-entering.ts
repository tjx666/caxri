import { useState } from 'react';
import { FadeIn, FadeInLeft, FadeInRight } from 'react-native-reanimated';

import type { SessionSegment } from '../session-ui-state';
import { sessionSegmentDirection } from '../session-ui-state';

export const PANEL_ENTER_MS = 220;
/**
 * How far an entering panel travels while it fades in, matching Reanimated's `FadeInLeft` and `FadeInRight`.
 */
const PANEL_ENTER_OFFSET = 25;
const enterFromRight = FadeInRight.duration(PANEL_ENTER_MS);
const enterFromLeft = FadeInLeft.duration(PANEL_ENTER_MS);
const enterInPlace = FadeIn.duration(PANEL_ENTER_MS);

/**
 * The horizontal start offset of a panel that enters from `direction`: positive enters from the right.
 */
export const segmentEnterOffset = (direction: -1 | 0 | 1): number => direction * PANEL_ENTER_OFFSET;

/**
 * The entering animation for the panel a tab switch reveals. It slides in from the side the tab strip moved toward; the
 * first panel of a Session appears without motion because the screen transition already animates it.
 *
 * @returns The switch direction (`null` for the first panel) and the matching mount-time `entering` animation.
 */
export const useSegmentEntering = (segment: SessionSegment, order: readonly SessionSegment[]) => {
    const [transition, setTransition] = useState<{
        direction: -1 | 0 | 1 | null;
        segment: SessionSegment;
    }>({ direction: null, segment });
    if (transition.segment !== segment)
        setTransition({
            direction: sessionSegmentDirection(transition.segment, segment, order),
            segment,
        });
    const { direction } = transition;
    const entering =
        direction === null
            ? undefined
            : direction > 0
              ? enterFromRight
              : direction < 0
                ? enterFromLeft
                : enterInPlace;
    return { direction, entering };
};
