import { useEffect } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import {
    settlePinnedSessionReveal,
    usePinnedSessionRevealStore,
} from '../../session/pinned-session-reveal';
import { primarySidebarPinnedRowId } from '../primary-sidebar-tree';

/**
 * Answers a successful pin (`requestPinnedSessionReveal`): opens the Pinned group and its window down to the new row,
 * scrolls the row into view, and returns the `Pinned <title>` sentence for the group's live region, the same report an
 * `Alt+Arrow` move gives. The request is consumed only once the refreshed Session list contains the pinned row, because
 * the pin's refresh may land a render after the request.
 */
export function usePinnedSessionReveal({
    expandPinned,
    pinnedSessions,
    revealSession,
}: {
    expandPinned: () => void;
    pinnedSessions: readonly SessionRecord[];
    revealSession: (sessionId: string) => void;
}): string {
    const request = usePinnedSessionRevealStore((state) => state.request);
    const announcement = usePinnedSessionRevealStore((state) => state.announcement);
    useEffect(() => {
        if (!request) return;
        const session = pinnedSessions.find((candidate) => candidate.id === request.sessionId);
        if (!session) return;
        settlePinnedSessionReveal(`Pinned ${session.displayTitle}`);
        expandPinned();
        revealSession(session.id);
        const rowId = primarySidebarPinnedRowId(session.id);
        // Two frames: the expanded group and the widened window render first, then the row exists to scroll to.
        requestAnimationFrame(() =>
            requestAnimationFrame(() =>
                document
                    .querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
                    ?.scrollIntoView({ block: 'nearest' }),
            ),
        );
    }, [expandPinned, pinnedSessions, request, revealSession]);
    return announcement;
}
