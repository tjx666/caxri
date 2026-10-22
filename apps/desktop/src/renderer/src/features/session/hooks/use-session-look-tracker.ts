import { useCallback, useEffect } from 'react';

import { useOnVisible } from '@/hooks/use-on-visible';

import { useSelectedSessionId } from '../../../stores/selectors';
import { setWatchedSession } from '../session-look-boundary';

function isWindowShown(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Records when the user looks at and leaves the selected Session, for the Chat's "since you last looked" hint. This
 * runs from the Renderer's own selection and window state, so the boundary is captured before the Session is marked
 * read.
 */
export function useSessionLookTracker(): void {
    const sessionId = useSelectedSessionId();
    const sync = useCallback((): void => {
        setWatchedSession(isWindowShown() ? sessionId : undefined);
    }, [sessionId]);
    useEffect(() => {
        sync();
    }, [sync]);
    useOnVisible(sync);
    useEffect(() => {
        window.addEventListener('blur', sync);
        document.addEventListener('visibilitychange', sync);
        return () => {
            window.removeEventListener('blur', sync);
            document.removeEventListener('visibilitychange', sync);
        };
    }, [sync]);
}
