import { useCallback, useEffect } from 'react';

import { useOnVisible } from '@/hooks/use-on-visible';

import { selectSelectedSession, useSelectedSessionId } from '../../../stores/selectors';
import { useWorkbenchStore } from '../../../stores/workbench';
import { setWatchedSession } from '../session-look-boundary';

function isWindowShown(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Records when the user looks at and leaves the selected Session, for the Chat's "since you last looked" hint. This
 * runs from the Renderer's own selection and window state, so the boundary is captured before the Session is marked
 * read. Server Core records the same leave durably from window presence; this hook only reads that copy back.
 */
export function useSessionLookTracker(): void {
    const sessionId = useSelectedSessionId();
    const sync = useCallback((): void => {
        // Read at call time rather than subscribed: the boundary only matters at the moment of looking, and a records
        // refresh must not re-run the tracker.
        const session = selectSelectedSession(useWorkbenchStore.getState().bootstrap);
        const persisted = session && session.id === sessionId ? session.lastViewedAt : undefined;
        setWatchedSession(isWindowShown() ? sessionId : undefined, persisted);
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
