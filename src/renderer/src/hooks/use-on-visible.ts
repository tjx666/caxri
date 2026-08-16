import { useEffect, useRef } from 'react';

/**
 * Invokes `callback` whenever the app window becomes visible/focused again: on `window` `focus`, on `document`
 * `visibilitychange` (when the document becomes visible), and optionally on `window` `pageshow` (useful for bfcache
 * restores). Useful for refreshing data that may have gone stale while the window was backgrounded.
 *
 * The callback is kept in a ref so callers can pass an inline closure without resubscribing listeners on every render.
 */
export function useOnVisible(callback: () => void, options?: { includePageShow?: boolean }): void {
    const callbackReference = useRef(callback);
    useEffect(() => {
        callbackReference.current = callback;
    });

    const isIncludePageShow = options?.includePageShow ?? false;

    useEffect(() => {
        const handleFocus = (): void => callbackReference.current();
        const handleVisibilityChange = (): void => {
            if (document.visibilityState === 'visible') callbackReference.current();
        };

        window.addEventListener('focus', handleFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        if (isIncludePageShow) window.addEventListener('pageshow', handleFocus);

        return () => {
            window.removeEventListener('focus', handleFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            if (isIncludePageShow) window.removeEventListener('pageshow', handleFocus);
        };
    }, [isIncludePageShow]);
}
