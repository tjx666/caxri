import { useEffect } from 'react';

import type { SessionRecord } from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';

import { settleSessionReveal, useSessionRevealStore } from '../../session/session-reveal-request';
import { scrollPrimarySidebarRowIntoView } from '../scroll-primary-sidebar-row';

/**
 * Answers `revealSessionInSidebar` ("Reveal in Sidebar" on a tab): expands the Session's Project or the Pinned group
 * and scrolls its row into view. Unlike `useSelectedSessionReveal` it acts on an explicit request, so it also works for
 * a Session that is already selected. The request waits for the Session record, because a request can arrive a snapshot
 * before the list that holds it.
 */
export function useSessionRevealRequest({
    revealPinnedSession,
    revealSessionRow,
    revealThrough,
    sessions,
}: {
    /**
     * Widens the Pinned group's window down to the Session.
     */
    revealPinnedSession: (sessionId: string) => void;
    revealSessionRow: (session: SessionRecord) => string;
    /**
     * Widens a Project's `Show N more` window down to the Session. A requested Session is not necessarily the selected
     * one, which the windows already pin on screen.
     */
    revealThrough: (projectId: string, sessionId: string) => void;
    sessions: readonly SessionRecord[];
}): void {
    const request = useSessionRevealStore((state) => state.request);
    useEffect(() => {
        if (!request) return;
        const session = sessions.find((candidate) => candidate.id === request.sessionId);
        if (!session) return;
        settleSessionReveal();
        if (isPinnedSession(session)) revealPinnedSession(session.id);
        else revealThrough(session.projectId, session.id);
        scrollPrimarySidebarRowIntoView(revealSessionRow(session));
    }, [request, revealPinnedSession, revealSessionRow, revealThrough, sessions]);
}
