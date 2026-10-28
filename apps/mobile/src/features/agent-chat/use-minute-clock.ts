import { useEffect, useState } from 'react';

const TICK_MS = 60_000;

/**
 * The current time, refreshed once a minute while the component shows, for text that counts down to a reset.
 */
export const useMinuteClock = (): number => {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, []);
    return now;
};
