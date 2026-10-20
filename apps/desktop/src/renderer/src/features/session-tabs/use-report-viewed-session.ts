import { useEffect } from 'react';

import { reportViewedSession } from './window-viewing-commands';

/**
 * Reports the Session this window shows whenever it changes, including the first render and a switch to none. Takes the
 * ID rather than reading a store, so the Workbench (which already subscribes to the selection) is the only caller and
 * nothing else re-renders for it.
 */
export function useReportViewedSession(selectedSessionId: string | undefined): void {
    useEffect(() => {
        // Fire-and-forget: the report is best effort and swallows its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard
        void reportViewedSession(selectedSessionId ?? null);
    }, [selectedSessionId]);
}
