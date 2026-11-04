import type { ReactNode } from 'react';

import type { SessionListWindow, SessionRecord, TerminalRecord } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { sessionAgentTerminal } from '../../session/session-agent-terminal';
import { sessionTitleForDisplay } from '../../session/session-title';
import type { SessionOrderController } from '../hooks/use-session-order';
import type { SessionRenameController } from '../hooks/use-session-rename';
import { MemoizedActiveSessionRow } from '../memoized-active-session-row';
import {
    primarySidebarDelegatedRevealRowId,
    primarySidebarDelegatedRowId,
} from '../primary-sidebar-tree';
import { SessionRevealRow } from '../session-reveal-row';
import type { DelegatedRowLookups } from './hooks/use-delegated-row-lookups';

/**
 * The nested rows of one host, as a render function a group calls after each of its Session rows with that row's
 * Session and the group's own order controller. Returns nothing for a Session that hosts no nested Session.
 */
export type RenderDelegatedRows = (
    host: SessionRecord,
    sessionOrder: SessionOrderController,
) => ReactNode;

/**
 * Nested rows are not part of any reorderable list, so they have no ids to hand to `Alt+Arrow`.
 */
const NO_VISIBLE_SESSION_IDS: readonly string[] = [];

interface DelegatedSessionRowsProperties {
    /**
     * The nested Sessions whose delegation failed (`DelegationFeed.failedSessionIds`).
     */
    failedSessionIds: ReadonlySet<string>;
    /**
     * The nested Chat Sessions whose permission request waits on the user (`DelegationFeed.approvalSessionIds`).
     */
    approvalSessionIds: ReadonlySet<string>;
    /**
     * The Session row these rows sit under.
     */
    host: SessionRecord;
    lookups: DelegatedRowLookups;
    /**
     * Steps the host's window forward (`Show N more`).
     */
    onRevealMore: () => void;
    rovingRowId?: string;
    selectedSessionId?: string;
    sessionOrder: SessionOrderController;
    sessionRename: SessionRenameController;
    /**
     * The host's window: the nested Sessions to render and the settled ones its reveal row would add.
     */
    sessionWindow: SessionListWindow<SessionRecord>;
    terminals: TerminalRecord[];
}

/**
 * The Sessions a host delegated work to, as level-3 rows under it (issue #3572). Each is an ordinary Session row (the
 * same hover card, context menu, rename, and archive) that names its own Project and shows its status, indented under a
 * guide line like the subagent rows above it. The rows keep their real Session ids for every action; only the tree row
 * id (`delegated-session:<id>`) is namespaced.
 *
 * A nested Session lists no subagents, and it cannot be dragged, dropped on, or moved with `Alt+Arrow`: it follows from
 * the Session that created it. The failure glyph and the creator's title arrive as plain fields per row so the memoized
 * row re-renders only when its own value moves.
 */
export function DelegatedSessionRows({
    approvalSessionIds,
    failedSessionIds,
    host,
    lookups,
    onRevealMore,
    rovingRowId,
    selectedSessionId,
    sessionOrder,
    sessionRename,
    sessionWindow,
    terminals,
}: DelegatedSessionRowsProperties) {
    const { t } = useTranslation();
    const { hiddenCount, nextRevealCount, visibleSessions } = sessionWindow;
    if (hiddenCount === 0 && visibleSessions.length === 0) return null;
    const hostTitle = sessionTitleForDisplay(host.title, t);
    const revealRowId = primarySidebarDelegatedRevealRowId(host.id);
    return (
        <div
            aria-label={t('primarySidebar.delegated.ariaLabel', { title: hostTitle })}
            className="delegated-list relative pl-4"
            role="group"
        >
            {/*
             * Decorative indent guide under the host's Agent icon (x = row padding + half the 14px icon), the same line
             * the subagent rows draw, tying the rows to the Session above them. Not a click target.
             */}
            <span
                aria-hidden="true"
                className="delegated-guide pointer-events-none absolute top-0 bottom-1.5 left-[15px] w-px bg-muted/40"
            />
            {visibleSessions.map((session) => {
                const project = lookups.projectsById.get(session.projectId);
                if (!project) return null;
                const rowId = primarySidebarDelegatedRowId(session.id);
                const creator =
                    session.createdBySessionId === undefined
                        ? undefined
                        : lookups.sessionsById.get(session.createdBySessionId);
                return (
                    <MemoizedActiveSessionRow
                        key={session.id}
                        approvalPending={approvalSessionIds.has(session.id)}
                        delegatedBy={creator && sessionTitleForDisplay(creator.title, t)}
                        delegationFailed={failedSessionIds.has(session.id)}
                        focusRenameInput={sessionRename.focusRenameInput}
                        nested
                        onBeginRename={sessionRename.beginRename}
                        onBlurRename={sessionRename.blurRename}
                        onCancelRename={sessionRename.cancelRename}
                        onCommitRename={sessionRename.commitRename}
                        onRenameValueChange={sessionRename.onRenameValueChange}
                        onSuggestRename={sessionRename.suggestRename}
                        projectIcon={project.icon}
                        projectId={project.id}
                        projectRootPath={project.rootPath}
                        projectTitle={project.title}
                        renameError={sessionRename.renameError}
                        renameSuggesting={session.id === sessionRename.renameSuggestingSessionId}
                        renameValue={sessionRename.renameValue}
                        renaming={rowId === sessionRename.renamingRowId}
                        roving={rowId === rovingRowId}
                        rowId={rowId}
                        selected={session.id === selectedSessionId}
                        session={session}
                        sessionOrder={sessionOrder}
                        showHostMark
                        showProjectName
                        terminal={sessionAgentTerminal(session, terminals)}
                        visibleSessionIds={NO_VISIBLE_SESSION_IDS}
                        worktreeProject={lookups.worktreeProjects[session.id]}
                    />
                );
            })}
            {hiddenCount > 0 && (
                <SessionRevealRow
                    ariaLabel={t(
                        nextRevealCount === 1
                            ? 'primarySidebar.delegated.revealAriaLabelOne'
                            : 'primarySidebar.delegated.revealAriaLabelOther',
                        { count: nextRevealCount, title: hostTitle },
                    )}
                    count={nextRevealCount}
                    level={3}
                    roving={revealRowId === rovingRowId}
                    rowId={revealRowId}
                    onReveal={onRevealMore}
                />
            )}
        </div>
    );
}
