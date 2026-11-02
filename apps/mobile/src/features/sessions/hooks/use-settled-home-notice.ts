import { useEffect, useState } from 'react';

import type { HomeNoticeKind } from '../session-notices';
import { createHomeNoticeSelections, homeNoticeSettleDelay } from '../session-notices';

const selections = createHomeNoticeSelections();

const isSettled = (kind: HomeNoticeKind | null, delay: number, now: number): boolean => {
    if (kind === null || delay === 0) return true;
    const since = selections.since(kind);
    return since !== null && now - since >= delay;
};

/**
 * The notice Session home actually draws. A self-clearing notice (`homeNoticeSettleDelay`) appears only once it has
 * stayed selected for the whole delay, counted from the first screen that selected it, so a startup that connects
 * quickly never shifts the list while a Session opened during an outage shows the notice at once. Any other notice, and
 * the absence of one, applies on the same render.
 */
export const useSettledHomeNotice = (kind: HomeNoticeKind | null): HomeNoticeKind | null => {
    const delay = homeNoticeSettleDelay(kind);
    // Read once at mount so a screen opened after the delay already passed draws the notice on its first frame.
    const [settled, setSettled] = useState<HomeNoticeKind | null>(() =>
        isSettled(kind, delay, Date.now()) ? kind : null,
    );
    useEffect(() => {
        if (kind === null || delay === 0) return;
        const now = Date.now();
        const since = selections.acquire(kind, now);
        const timer = setTimeout(() => setSettled(kind), Math.max(0, since + delay - now));
        return () => {
            clearTimeout(timer);
            selections.release(kind);
            // A notice that clears and comes back must wait out the delay again.
            setSettled(null);
        };
    }, [delay, kind]);
    return delay === 0 || settled === kind ? kind : null;
};
