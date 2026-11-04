import { createElement } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { SESSION_REVEAL_STEP } from '@caxri/protocol';

import type { SessionRenameController } from '../../hooks/use-session-rename';
import { primarySidebarDelegatedRowId } from '../../primary-sidebar-tree';
import type { RenderDelegatedRows } from '../delegated-session-rows';
import { DelegatedSessionRows } from '../delegated-session-rows';
import { useDelegatedRowLookups } from './use-delegated-row-lookups';
import type { DelegatedSessionsModel } from './use-delegated-sessions';

/**
 * Binds the nested rows to the tree's state: the record lookups they name Projects and creators from, the failure set
 * the delegation feed produced, and the reveal handoff. Returns the render function the Project groups and the Pinned
 * group call after each host row, so the tree component passes one prop instead of the model behind it.
 */
export function useRenderDelegatedRows({
    allProjects,
    delegated,
    focusRow,
    rovingRowId,
    selectedSessionId,
    sessionRename,
    sessions,
    terminals,
}: {
    /**
     * The full Project catalog, hidden worktree Projects included.
     */
    allProjects: readonly ProjectRecord[];
    delegated: DelegatedSessionsModel;
    focusRow: (rowId: string) => void;
    rovingRowId: string | undefined;
    selectedSessionId: string | undefined;
    sessionRename: SessionRenameController;
    sessions: readonly SessionRecord[];
    terminals: TerminalRecord[];
}): RenderDelegatedRows {
    const lookups = useDelegatedRowLookups({
        allProjects,
        placement: delegated.placement,
        sessions,
    });
    /**
     * The final reveal unmounts the reveal row itself, which would drop the tree's roving Tab stop onto the document
     * body, so focus moves to the nested row directly above it first: the same handoff the Project groups' reveal row
     * makes.
     */
    const revealMore = (hostSessionId: string): void => {
        const hostWindow = delegated.children.windows.get(hostSessionId);
        if (!hostWindow) return;
        delegated.children.revealMore(hostSessionId, hostWindow.windowCount);
        const lastVisibleSessionId = hostWindow.visibleSessions.at(-1)?.id;
        if (lastVisibleSessionId && hostWindow.hiddenCount <= SESSION_REVEAL_STEP)
            focusRow(primarySidebarDelegatedRowId(lastVisibleSessionId));
    };
    // `createElement` rather than JSX keeps this a plain `.ts` hook module; the element is the same.
    return (host, hostSessionOrder) => {
        const sessionWindow = delegated.children.windows.get(host.id);
        return sessionWindow
            ? createElement(DelegatedSessionRows, {
                  approvalSessionIds: delegated.feed.approvalSessionIds,
                  failedSessionIds: delegated.feed.failedSessionIds,
                  host,
                  lookups,
                  onRevealMore: () => revealMore(host.id),
                  rovingRowId,
                  selectedSessionId,
                  sessionOrder: hostSessionOrder,
                  sessionRename,
                  sessionWindow,
                  terminals,
              })
            : null;
    };
}
