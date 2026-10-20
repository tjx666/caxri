import { useState } from 'react';

import type { AgentExcerpt, ProjectRecord } from '@caxri/protocol';
import { Check } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSessionPullRequest } from '../primary-sidebar/hooks/use-session-pull-request';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import { useSessionTitleScroll } from '../primary-sidebar/hooks/use-session-title-scroll';
import { SessionActivityCard } from '../primary-sidebar/session-activity-card';
import { sessionRowActionButton } from '../primary-sidebar/session-row-actions';
import { SessionRowMenu } from '../primary-sidebar/session-row-menu';
import { sessionTitleForDisplay } from '../session/session-title';
import { AgentActivityRowTrigger } from './agent-activity-row-trigger';
import type { AgentActivityRow } from './agent-activity-rows';

/**
 * One Session in the Activity list: a state glyph, the Session title with its pull request, and below them the Agent,
 * Project, worktree, and time.
 *
 * The state is a shape rather than a phrase because every group heading already names it: a row under "Working" that
 * also prints "Working" repeats its own heading, and the phrase costs the width the Project name needs in a 230px
 * column. `agent-activity-glyph.ts` owns which shape, which words, and the tone rule behind them.
 *
 * The row wears the same hover card and context menu as a Project tree row, so a Session reads and acts the same in
 * either body of the side bar, including the inline rename editor.
 */
export function AgentActivityRowItem({
    excerpt,
    inPinnedGroup,
    onMarkRead,
    relativeTime,
    roving,
    row,
    selected,
    sessionRename,
    worktreeProject,
    onFocusChange,
}: {
    /**
     * What the Agent last asked or said, shown under the row's metadata when the Session needs a look.
     */
    excerpt: AgentExcerpt | undefined;
    /**
     * True for the Pinned group's copy, so its hover card says the row is pinned.
     */
    inPinnedGroup: boolean;
    onFocusChange: (rowId: string) => void;
    onMarkRead: () => void;
    relativeTime: string | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
    sessionRename: SessionRenameController;
    /**
     * Workbench Root Project when this Session works in a linked worktree instead of its own Project root.
     */
    worktreeProject: ProjectRecord | undefined;
}) {
    const { t } = useTranslation();
    const { project, session, terminal } = row;
    const isRenaming = sessionRename.renamingRowId === row.rowId;
    const beginRename = () =>
        sessionRename.beginRename(session.id, session.displayTitle, row.rowId);
    const canMarkRead = session.hasUnread;
    const { pullRequest, unavailable: pullRequestUnavailable } = useSessionPullRequest(session.id);
    const visiblePullRequest = pullRequestUnavailable ? undefined : pullRequest;
    /**
     * The hover card opens on a delay and would otherwise pop over an open context menu; closing it while the menu is
     * open keeps one popup on screen at a time, the same as a Project tree row.
     */
    const [menuOpen, setMenuOpen] = useState(false);
    // Same title-reveal hook `active-session-row.tsx` uses (DESIGN.md: "Hovered or keyboard-focused clipped sidebar
    // titles may scroll solely to reveal their text"), so a clipped title behaves the same in either body of the side
    // bar. Called here because `AgentActivityRowTrigger` is invoked as a plain function and cannot own hooks.
    const titleScroll = useSessionTitleScroll(
        sessionTitleForDisplay(session.displayTitle, t),
        isRenaming || menuOpen,
    );
    const trigger = AgentActivityRowTrigger({
        beginRename,
        canMarkRead,
        excerpt,
        isRenaming,
        onFocusChange,
        onMarkRead,
        relativeTime,
        roving,
        row,
        selected,
        sessionRename,
        t,
        titleScroll,
        visiblePullRequest,
        worktreeProject,
    });
    return (
        <SessionRowMenu
            onBeginRename={beginRename}
            onSuggestRename={() =>
                sessionRename.suggestRename(session.id, session.displayTitle, row.rowId)
            }
            onMarkRead={canMarkRead ? onMarkRead : undefined}
            onOpenChange={setMenuOpen}
            project={project}
            pullRequest={visiblePullRequest}
            session={session}
        >
            <div className="agent-activity-row-shell group/activity-row relative">
                <SessionActivityCard
                    inPinnedGroup={inPinnedGroup}
                    project={project}
                    pullRequest={pullRequest}
                    pullRequestUnavailable={pullRequestUnavailable}
                    session={session}
                    suppressed={menuOpen || isRenaming}
                    terminal={terminal}
                    trigger={trigger}
                    worktreeProject={worktreeProject}
                />
                {canMarkRead && !isRenaming && (
                    <AgentActivityMarkReadButton
                        sessionTitle={sessionTitleForDisplay(session.displayTitle, t)}
                        onMarkRead={onMarkRead}
                    />
                )}
            </div>
        </SessionRowMenu>
    );
}

/**
 * A sibling of the row rather than a child, the same way a Project tree row keeps its hover actions outside the hover
 * card's trigger: a pointer on the button is not a pointer asking for the card. It wears the Project tree's
 * hover-action chip and tooltip, so a Session's pointer actions look the same in either body of the side bar.
 *
 * `tabIndex={-1}`: inside `role="tree"` the row itself is the only Tab stop (DESIGN.md), so this is the pointer
 * affordance for an action the keyboard reaches through Delete on the row.
 */
function AgentActivityMarkReadButton({
    onMarkRead,
    sessionTitle,
}: {
    onMarkRead: () => void;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip content={t('agentActivity.markRead')}>
            <button
                aria-label={t('agentActivity.markSessionRead', { title: sessionTitle })}
                aria-keyshortcuts="Delete"
                className={cn(
                    sessionRowActionButton,
                    'agent-activity-mark-read absolute top-1/2 right-1 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/activity-row:opacity-100 focus-visible:opacity-100',
                )}
                tabIndex={-1}
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    onMarkRead();
                }}
            >
                <Check aria-hidden="true" size={12} />
            </button>
        </Tooltip>
    );
}
