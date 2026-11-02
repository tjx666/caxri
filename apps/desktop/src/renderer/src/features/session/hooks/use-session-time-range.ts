import { useState } from 'react';

import type { SessionTimeRange } from '../session-time-range';
import { sessionTimeRangeStart } from '../session-time-range';

interface TimeRangeSelection {
    range: SessionTimeRange;
    /**
     * Epoch milliseconds that open the window, or undefined for `all`.
     */
    start?: number;
}

const ANY_TIME: TimeRangeSelection = { range: 'all' };

/**
 * The selected time range and the time it starts from. The start is computed when the user picks a range, not during
 * render, so it stays a stable filter and query key; a dialog left open across midnight keeps the window it was given
 * until the range is picked again.
 */
export function useSessionTimeRange() {
    const [selection, setSelection] = useState<TimeRangeSelection>(ANY_TIME);
    return {
        timeRange: selection.range,
        timeRangeStart: selection.start,
        setTimeRange: (range: SessionTimeRange) =>
            setSelection({ range, start: sessionTimeRangeStart(range, Date.now()) }),
    };
}
