import type { ComponentProps } from 'react';

import type { ErrorBoundary } from '../../components/error-boundary';
import { caxri } from '../../lib/caxri';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useWorkbenchStore } from '../../stores/workbench';
import { noteSessionSelection, readComposedSnapshot } from '../../stores/workbench-environments';
import { createRecoveringSnapshotSource } from './recovering-snapshot-source';
import { recordRenderCrash } from './render-crash-recovery';

function activeSessionId(): string | undefined {
    return useWorkbenchStore.getState().bootstrap?.selectedSessionId;
}

/**
 * Snapshot source for the main Workbench window: the composed read of every machine it reaches, except that the first
 * load after a render crash loop moves the window off the crashing Session first.
 */
export const recoveringSnapshotSource = createRecoveringSnapshotSource({
    now: Date.now,
    readSnapshot: readComposedSnapshot,
    selectSession: (sessionId) => {
        noteSessionSelection(sessionId);
        return caxri.request('session.select', { sessionId });
    },
    storage: sessionStorage,
});

/**
 * Crash-screen props for the main Workbench window: record every render crash with its active Session, and offer a
 * one-click reload that skips that Session.
 */
export const workbenchCrashBoundary: Omit<ComponentProps<typeof ErrorBoundary>, 'children'> = {
    onRenderError: () => {
        recordRenderCrash(sessionStorage, { now: Date.now(), sessionId: activeSessionId() });
        // The Activity queue is persisted device-local state that re-mounts on reload; leaving it here keeps a crash in
        // that body from repeating on every load.
        useChromeLayoutStore.getState().leavePrimarySidebarActivityMode();
    },
    recoveryAction: {
        isAvailable: () => activeSessionId() !== undefined,
        labelKey: 'core.errorBoundary.reloadWithoutSession',
        run: () => {
            recordRenderCrash(sessionStorage, {
                now: Date.now(),
                sessionId: activeSessionId(),
                skipRequested: true,
            });
            useChromeLayoutStore.getState().leavePrimarySidebarActivityMode();
        },
    },
};
