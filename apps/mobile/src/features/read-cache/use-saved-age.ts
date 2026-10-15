import { useEffect, useState } from 'react';

import { useTranslation } from '../../i18n';
import { savedAgeLabel } from '../sessions/session-row-model';

const SAVED_AGE_TICK_MS = 30_000;

/**
 * The current time for labeling a saved copy's age, advanced every 30 seconds while the copy stays on screen.
 */
export const useSavedClock = (savedAt: number | null): number => {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (savedAt === null) return;
        const timer = setInterval(() => setNow(Date.now()), SAVED_AGE_TICK_MS);
        return () => clearInterval(timer);
    }, [savedAt]);
    return now;
};

/**
 * `saved 5m ago` for a saved copy on screen, kept current while it stays there; `null` for a live view.
 */
export const useSavedAge = (savedAt: number | null): string | null => {
    const now = useSavedClock(savedAt);
    const { t } = useTranslation();
    return savedAt === null ? null : savedAgeLabel(savedAt, now, t);
};
