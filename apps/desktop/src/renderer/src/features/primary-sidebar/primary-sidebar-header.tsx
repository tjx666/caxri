import type { CSSProperties } from 'react';
import { useMemo } from 'react';

import { ListTodo } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { CaxriLogo } from '../../components/caxri-logo';
import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useProjects, useSessions } from '../../stores/selectors';
import { agentAttentionCount } from '../agent-activity/agent-activity-rows';
import { topLevelProjects } from './project-visibility';
import { SessionHistoryNavigation } from './session-history-navigation';

const NO_RECORDS: never[] = [];
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

/**
 * Past this the tally stops being readable at 10px and starts being a shape.
 */
const MAX_BADGE_COUNT = 99;

/**
 * Switches the side bar between the Project tree and the Activity queue, and carries the queue's own tally.
 *
 * The badge is the reason this lives in the header rather than inside Activity: it has to be legible while the tree is
 * showing, which is exactly when the queue is unmounted. {@link agentAttentionCount} reads the same `hasUnread` flag the
 * queue's "Needs attention" group is derived from, so the two agree without the badge depending on the queue existing.
 */
function ActivityModeToggle({ isActivityMode }: { isActivityMode: boolean }) {
    const allProjects = useProjects();
    const sessions = useSessions() ?? NO_RECORDS;
    const attentionCount = useMemo(
        () => agentAttentionCount(topLevelProjects(allProjects ?? NO_RECORDS), sessions),
        [allProjects, sessions],
    );
    const { t } = useTranslation();
    const badge = attentionCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(attentionCount);

    return (
        <CommandTooltip commandId="primarySidebar.toggleActivity">
            <Button
                className="primary-sidebar-activity-toggle relative text-muted enabled:hover:text-foreground aria-pressed:bg-list-active-selection-background aria-pressed:text-foreground"
                size="icon"
                variant="ghost"
                aria-label={t(
                    isActivityMode
                        ? 'primarySidebar.header.showProjects'
                        : 'primarySidebar.header.showActivity',
                )}
                aria-pressed={isActivityMode}
                data-activity-mode={isActivityMode}
                onClick={() => executeCommand('primarySidebar.toggleActivity')}
            >
                {/*
                 * A to-do list, because the button swaps the side bar to a queue of Sessions ordered by what is still on
                 * the user's plate. Neither notification picture fits: the status bar's `Bell`
                 * (`features/toasts/notification-center.tsx`) holds app notifications, and `Inbox` already marks the
                 * Peer Inbox's held peer messages (the status bar's `peer-approval-chip.tsx` and the waiting list in
                 * `features/agent-inbox/`).
                 */}
                <ListTodo size={14} />
                {attentionCount > 0 && (
                    <span
                        aria-hidden="true"
                        className="primary-sidebar-activity-badge absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-badge px-1 text-[10px] leading-none font-semibold text-badge-foreground tabular-nums ring-2 ring-surface"
                        data-activity-badge={badge}
                    >
                        {badge}
                    </span>
                )}
                {/* The badge is `aria-hidden` because "3" alone says nothing; the count reaches assistive technology
                    here instead, where it can carry its own noun. */}
                <span className="sr-only">
                    {attentionCount === 0
                        ? t('primarySidebar.header.attentionNone')
                        : t(
                              attentionCount === 1
                                  ? 'primarySidebar.header.attentionOne'
                                  : 'primarySidebar.header.attentionOther',
                              { count: attentionCount },
                          )}
                </span>
            </Button>
        </CommandTooltip>
    );
}

export function PrimarySidebarHeader({
    isActivityMode,
    isFullScreen,
}: {
    isActivityMode: boolean;
    isFullScreen: boolean;
}) {
    return (
        <div
            className={`primary-sidebar-title flex h-9 items-center py-0 pr-2 font-semibold ${isFullScreen ? 'pl-3' : 'pl-(--traffic-light-header-inset)'}`}
            style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
            {isFullScreen && <CaxriLogo className="mr-2" />}
            <SessionHistoryNavigation />
            {/*
             * The header is the window's drag region, so anything clickable inside it has to opt out or the pointer
             * moves the window instead. `SessionHistoryNavigation` carries its own opt-out for the same reason.
             */}
            <div className="ml-auto flex items-center" style={NO_DRAG}>
                <ActivityModeToggle isActivityMode={isActivityMode} />
            </div>
        </div>
    );
}
