import { useEffect, useRef, useState } from 'react';

import type { HomeNoticeKind } from '../session-notices';
import {
    createHomeNoticeSelections,
    drawnHomeNotice,
    HOME_NOTICE_HOLD_MS,
    homeNoticeSettleDelay,
} from '../session-notices';

const selections = createHomeNoticeSelections();

const isSettled = (kind: HomeNoticeKind | null, delay: number, now: number): boolean => {
    if (kind === null || delay === 0) return true;
    const since = selections.since(kind);
    return since !== null && now - since >= delay;
};

/**
 * The notice Session home actually draws. A self-clearing notice (`homeNoticeSettleDelay`) appears only once it has
 * stayed selected for the whole delay, counted from the first screen that selected it, so a startup or resume that
 * reconnects quickly never shifts the list while a Session opened during an outage shows the notice at once. Once on
 * screen it stays for `HOME_NOTICE_HOLD_MS` after it clears, and comes straight back if selected again within that
 * window, so a flaky network does not draw it in and out. Any other notice applies on the same render. While the most
 * severe candidate waits, `drawnHomeNotice` picks what to draw instead.
 */
export const useSettledHomeNotice = (
    candidates: readonly HomeNoticeKind[],
): HomeNoticeKind | null => {
    const kind = candidates.at(0) ?? null;
    const delay = homeNoticeSettleDelay(kind);
    // Read once at mount so a screen opened after the delay already passed draws the notice on its first frame.
    const [settled, setSettled] = useState<HomeNoticeKind | null>(() =>
        delay > 0 && isSettled(kind, delay, Date.now()) ? kind : null,
    );
    const [held, setHeld] = useState<HomeNoticeKind | null>(null);
    // Mirrors of `settled` and `held` for the effect below, which must not re-run (and re-acquire) on every change.
    const shownReference = useRef(settled);
    const heldReference = useRef<HomeNoticeKind | null>(null);
    const hold = (next: HomeNoticeKind | null): void => {
        heldReference.current = next;
        setHeld(next);
    };

    useEffect(() => {
        if (kind === null) return;
        if (delay === 0) {
            // A notice that shows at once has replaced the held one; it must not come back when that notice clears.
            if (heldReference.current !== null) hold(null);
            return;
        }
        const now = Date.now();
        const since = selections.acquire(kind, now);
        // Selected again while still held on screen: keep drawing it instead of waiting out the delay again.
        if (heldReference.current === kind) {
            shownReference.current = kind;
            setSettled(kind);
            hold(null);
        }
        const timer = setTimeout(
            () => {
                shownReference.current = kind;
                setSettled(kind);
            },
            Math.max(0, since + delay - now),
        );
        return () => {
            clearTimeout(timer);
            selections.release(kind);
            if (shownReference.current === kind) hold(kind);
            shownReference.current = null;
            // A notice that clears and comes back after the hold must wait out the delay again.
            setSettled(null);
        };
    }, [delay, kind]);

    useEffect(() => {
        if (held === null) return;
        const timer = setTimeout(() => hold(null), HOME_NOTICE_HOLD_MS);
        return () => clearTimeout(timer);
    }, [held]);

    return drawnHomeNotice({ candidates, held, settled });
};
