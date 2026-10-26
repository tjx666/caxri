import type { ComponentProps } from 'react';

import type { ErrorBoundary } from '../../components/error-boundary';
import { caxri } from '../../lib/caxri';
import { useWorkbenchStore } from '../../stores/workbench';
import { createRecoveringSnapshotSource } from './recovering-snapshot-source';
import { recordRenderCrash } from './render-crash-recovery';

function activeSessionId(): string | undefined {
    return useWorkbenchStore.getState().bootstrap?.selectedSessionId;
}

/**
 * Snapshot source for the main Workbench window: the plain `app.bootstrap` read, except that the first load after a
 * render crash loop moves the window off the crashing Session first.
 */
export const recoveringSnapshotSource = createRecoveringSnapshotSource({
    now: Date.now,
    readSnapshot: () => caxri.request('app.bootstrap'),
    selectSession: (sessionId) => caxri.request('session.select', { sessionId }),
    storage: sessionStorage,
});

/**
 * Crash-screen props for the main Workbench window: record every render crash with its active Session, and offer a
 * one-click reload that skips that Session.
 */
export const workbenchCrashBoundary: Omit<ComponentProps<typeof ErrorBoundary>, 'children'> = {
    onRenderError: () =>
        recordRenderCrash(sessionStorage, { now: Date.now(), sessionId: activeSessionId() }),
    recoveryAction: {
        isAvailable: () => activeSessionId() !== undefined,
        labelKey: 'core.errorBoundary.reloadWithoutSession',
        run: () =>
            recordRenderCrash(sessionStorage, {
                now: Date.now(),
                sessionId: activeSessionId(),
                skipRequested: true,
            }),
    },
};
