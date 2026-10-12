import { useEffect, useRef } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { scrollPrimarySidebarRowIntoView } from '../scroll-primary-sidebar-row';

/**
 * Opens the group holding a newly selected Session and scrolls its row into view, wherever the selection came from: a
 * click in the Agent Commander board, a notification, history navigation, or a CLI `session.select`. Without it a
 * Session in a Project the user collapsed by hand is selected with no visible row.
 *
 * Runs once per selection change, not on every render: collapsing the selected Session's Project afterwards is the
 * user's decision and stays in effect until a different Session is selected. The selection this sidebar observes at
 * mount, including none, is not a change, so a Project collapsed around the selected Session survives a relaunch. The
 * reveal waits for the Session record, because a selection made elsewhere can reach this window a snapshot before the
 * Session list that contains it.
 */
export function useSelectedSessionReveal({
    revealSessionRow,
    selectedSessionId,
    sessions,
}: {
    revealSessionRow: (session: SessionRecord) => string;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
}): void {
    const handledSessionIdReference = useRef<string | undefined>(undefined);
    const hasObservedSelectionReference = useRef(false);
    useEffect(() => {
        if (!hasObservedSelectionReference.current) {
            hasObservedSelectionReference.current = true;
            handledSessionIdReference.current = selectedSessionId;
            return;
        }
        if (!selectedSessionId || handledSessionIdReference.current === selectedSessionId) return;
        const session = sessions.find((candidate) => candidate.id === selectedSessionId);
        if (!session) return;
        handledSessionIdReference.current = selectedSessionId;
        scrollPrimarySidebarRowIntoView(revealSessionRow(session));
    }, [revealSessionRow, selectedSessionId, sessions]);
}
