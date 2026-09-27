import { useState } from 'react';
import { FadeIn, FadeInLeft, FadeInRight } from 'react-native-reanimated';

import type { SessionSegment } from '../session-ui-state';
import { sessionSegmentDirection } from '../session-ui-state';

const PANEL_ENTER_MS = 220;
const enterFromRight = FadeInRight.duration(PANEL_ENTER_MS);
const enterFromLeft = FadeInLeft.duration(PANEL_ENTER_MS);
const enterInPlace = FadeIn.duration(PANEL_ENTER_MS);

/**
 * The entering animation for the panel a tab switch reveals. It slides in from the side the tab strip moved toward; the
 * first panel of a Session appears without motion because the screen transition already animates it.
 */
export const useSegmentEntering = (segment: SessionSegment) => {
    const [transition, setTransition] = useState<{
        direction: -1 | 0 | 1 | null;
        segment: SessionSegment;
    }>({ direction: null, segment });
    if (transition.segment !== segment)
        setTransition({ direction: sessionSegmentDirection(transition.segment, segment), segment });
    if (transition.direction === null) return;
    return transition.direction > 0
        ? enterFromRight
        : transition.direction < 0
          ? enterFromLeft
          : enterInPlace;
};
