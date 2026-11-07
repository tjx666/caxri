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
 * One Session in the Activity list: the Session title with its pull request, and below it the Agent, Project, worktree,
 * and time.
 *
 * There is no state glyph: every group heading already names the state, so a glyph repeated it on each row and cost the
 * width the Project name needs in a 230px column. A Needs attention row offers a Mark as Done check at its right edge
 * on hover, focus, or selection, and an unread row sets its title in medium weight (`agentActivityStatusNote` covers
 * the states the heading cannot say). Nothing leads the row, so every group's titles share one left edge.
 *
 * The row wears the same hover card and context menu as a Project tree row, so a Session reads and acts the same in
 * either body of the side bar, including the inline rename editor.
 */
export function AgentActivityRowItem({
    excerpt,
    inPinnedGroup,
    onMarkDone,
    relativeTime,
    roving,
    row,
    selected,
    sessionRename,
    showExcerpts,
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
    onMarkDone: () => void;
    relativeTime: string | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
    sessionRename: SessionRenameController;
    /**
     * `agentActivity.showExcerpts`.
     */
    showExcerpts: boolean;
    /**
     * Workbench Root Project when this Session works in a linked worktree instead of its own Project root.
     */
    worktreeProject: ProjectRecord | undefined;
}) {
    const { t } = useTranslation();
    const { project, session, terminal } = row;
    const isRenaming = sessionRename.renamingRowId === row.rowId;
    const beginRename = () => sessionRename.beginRename(session.id, session.title, row.rowId);
    /**
     * The check button and Delete act only where the row shows it is waiting on the user. A running or pinned row can
     * still carry an older Pending Attention; there the explicit context-menu item is the only way to resolve it, so a
     * key press never clears something the row does not display.
     */
    const canMarkDone = session.hasPendingAttention && row.groupId === 'attention';
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
        sessionTitleForDisplay(session.title, t),
        isRenaming || menuOpen,
    );
    const trigger = AgentActivityRowTrigger({
        beginRename,
        canMarkDone,
        excerpt,
        isRenaming,
        onFocusChange,
        onMarkDone,
        relativeTime,
        roving,
        row,
        selected,
        sessionRename,
        showExcerpts,
        t,
        titleScroll,
        visiblePullRequest,
        worktreeProject,
    });
    return (
        <SessionRowMenu
            onBeginRename={beginRename}
            onSuggestRename={() =>
                sessionRename.suggestRename(session.id, session.title, row.rowId)
            }
            onMarkDone={session.hasPendingAttention ? onMarkDone : undefined}
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
                {!isRenaming && canMarkDone && (
                    <AgentActivityMarkDoneButton
                        selected={selected}
                        sessionTitle={sessionTitleForDisplay(session.title, t)}
                        onMarkDone={onMarkDone}
                    />
                )}
            </div>
        </SessionRowMenu>
    );
}

/**
 * The Mark as Done check, overlaid on the row's trailing slot where the pull request glyph sits. A sibling of the row
 * rather than a child, the same way a Project tree row keeps its hover actions outside the hover card's trigger: a
 * pointer on the button is not a pointer asking for the card, and a click on it must not select the row. It wears the
 * Project tree's hover-action chip and tooltip, so a Session's pointer actions look the same in either body of the side
 * bar.
 *
 * It shows on row hover, when anything in the row has focus, and on the selected row; otherwise it is invisible and
 * ignores the pointer, so the pull request glyph underneath stays visible. `tabIndex={-1}`: inside `role="tree"` the
 * row itself is the only Tab stop (DESIGN.md), so this is the pointer affordance for an action the keyboard reaches
 * through Delete on the row.
 */
function AgentActivityMarkDoneButton({
    onMarkDone,
    selected,
    sessionTitle,
}: {
    onMarkDone: () => void;
    selected: boolean;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    return (
        <div
            className={cn(
                'agent-activity-mark-done-slot absolute top-1/2 right-2 z-10 flex -translate-y-1/2 transition-opacity group-focus-within/activity-row:pointer-events-auto group-focus-within/activity-row:opacity-100 group-hover/activity-row:pointer-events-auto group-hover/activity-row:opacity-100',
                selected ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
        >
            <Tooltip content={t('agentActivity.markDone')} shortcut="delete">
                <button
                    aria-keyshortcuts="Delete"
                    aria-label={t('agentActivity.markSessionDone', { title: sessionTitle })}
                    className={cn(sessionRowActionButton, 'agent-activity-mark-done')}
                    tabIndex={-1}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onMarkDone();
                    }}
                >
                    <Check aria-hidden="true" size={12} />
                </button>
            </Tooltip>
        </div>
    );
}
