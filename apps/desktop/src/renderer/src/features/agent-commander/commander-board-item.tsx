import type { ComponentType } from 'react';

import type { CommanderBoardRow } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';
import {
    Bot,
    CheckCheck,
    Circle,
    CircleAlert,
    CircleCheck,
    CircleDashed,
    CircleDot,
    CircleQuestionMark,
    CircleStop,
    CircleX,
    Hand,
    LoaderCircle,
    Moon,
    Power,
    TriangleAlert,
    Unplug,
    ZapOff,
} from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import type { AgentActivityGlyphId } from '../agent-activity/agent-activity-glyph';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import { RunningArc } from '../primary-sidebar/session-status-indicator';
import type {
    CommanderChecksIconId,
    CommanderProcessIconId,
    CommanderTaskIconId,
} from './commander-board';
import {
    commanderPullRequestBadge,
    commanderRowPresentation,
    commanderTaskBadge,
} from './commander-board';
import { openCommanderPullRequest, revealCommanderSession } from './commander-commands';

type IconComponent = ComponentType<{ size?: number }>;

/**
 * The Activity view's glyph shapes, so a state looks the same in both windows. A running turn draws the
 * PrimarySidebar's running ring rather than the Activity view's spinner, because the board lists the same Sessions as
 * the sidebar.
 */
const GLYPH_COMPONENTS: Record<AgentActivityGlyphId, IconComponent> = {
    check: CircleCheck,
    dashed: CircleDashed,
    hollow: Circle,
    question: CircleQuestionMark,
    spinner: RunningArc,
    unplug: Unplug,
    x: CircleX,
};

const TASK_ICONS: Record<CommanderTaskIconId, IconComponent> = {
    'answered': CheckCheck,
    'blocked': CircleAlert,
    'failed': CircleX,
    'running': CircleDot,
    'starting': LoaderCircle,
    'stopped': CircleStop,
    'taken-over': Hand,
};

const PROCESS_ICONS: Record<CommanderProcessIconId, IconComponent> = {
    exited: Power,
    failed: TriangleAlert,
    interrupted: ZapOff,
    starting: LoaderCircle,
    suspended: Moon,
};

const CHECKS_ICONS: Record<CommanderChecksIconId, IconComponent> = {
    failed: CircleX,
    passed: CircleCheck,
    pending: CircleDot,
};

/**
 * One board row: what the Session is and when it last moved on the first line, where it runs on the second. Statuses
 * are icons with tooltips rather than words, so the Project name keeps the metadata line's width. The whole row reveals
 * its Session in the Workbench; the pull request chip is a separate control that opens the pull request in the browser,
 * stacked above the row's stretched hit area so the two never nest.
 */
export function CommanderBoardItem({
    now,
    row,
    showsOwnership,
}: {
    now: number;
    row: CommanderBoardRow;
    /**
     * Marks the Commander's own Sessions. Only the whole-Workbench scope needs it; the default scope lists nothing
     * else.
     */
    showsOwnership: boolean;
}) {
    const presentation = commanderRowPresentation(row);
    const badge = commanderPullRequestBadge(row);
    const task = commanderTaskBadge(row.task);
    const GlyphIcon = GLYPH_COMPONENTS[presentation.glyph];
    const ProcessIcon = presentation.processIcon && PROCESS_ICONS[presentation.processIcon];
    const ChecksIcon = badge?.checksIcon && CHECKS_ICONS[badge.checksIcon];
    return (
        <li
            className={cn(
                'commander-board-item relative flex items-start gap-2 rounded-md px-2 py-1.5 text-foreground',
                'hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]',
                'has-[.commander-board-reveal:focus-visible]:ring-1 has-[.commander-board-reveal:focus-visible]:ring-foreground',
            )}
            data-commander-group={row.group}
            data-session-id={row.sessionId}
        >
            <span
                role="img"
                aria-label={presentation.glyphLabel}
                className={cn(
                    'commander-board-glyph mt-0.5 flex size-3.5 flex-none items-center justify-center',
                    presentation.toneClassName,
                )}
                data-activity-glyph={presentation.glyph}
            >
                <GlyphIcon size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                    <button
                        type="button"
                        className="commander-board-reveal min-w-0 cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-md"
                        onClick={() => revealCommanderSession(row.sessionId)}
                    >
                        {row.sessionTitle}
                    </button>
                    {row.commanderSession && (task !== undefined || showsOwnership) && (
                        <CommanderTaskIcon showsOwnership={showsOwnership} task={task} />
                    )}
                    <span className="commander-board-time ml-auto flex-none pl-1 text-[11px] whitespace-nowrap text-muted tabular-nums">
                        {relativeTime(row.lastActivityAt, now, 'narrow')}
                    </span>
                </span>
                <span className="commander-board-metadata flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted">
                    <Tooltip content={presentation.agentLabel}>
                        <span className="relative flex size-3 flex-none items-center justify-center">
                            <AgentIdentityIcon identity={row.agent?.kind ?? 'shell'} size={12} />
                        </span>
                    </Tooltip>
                    <span className="sr-only">{presentation.agentLabel}</span>
                    {/* The fade masks the box's last 8px; the matching padding keeps a name that fits clear of it. */}
                    <span className="overflow-fade -mr-1.5 min-w-0 shrink pr-2">
                        {row.projectTitle}
                    </span>
                    {ProcessIcon ? (
                        <Tooltip content={presentation.statePhrase}>
                            <span
                                role="img"
                                aria-label={presentation.statePhrase}
                                className="commander-board-process relative flex size-3 flex-none items-center justify-center"
                                data-process-icon={presentation.processIcon}
                            >
                                <ProcessIcon size={11} />
                            </span>
                        </Tooltip>
                    ) : (
                        <span className="sr-only">{presentation.statePhrase}</span>
                    )}
                    {badge && (
                        <Tooltip content={badge.title}>
                            <button
                                type="button"
                                aria-label={badge.ariaLabel}
                                className="commander-board-pull-request relative ml-auto flex h-4 flex-none cursor-pointer items-center gap-0.5 rounded pl-1 text-[11px] leading-4 text-muted tabular-nums outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground"
                                onClick={() => openCommanderPullRequest(badge.url)}
                            >
                                <SessionPullRequestIndicator pullRequest={row.pullRequest} />
                                <span>{badge.numberLabel}</span>
                                {ChecksIcon && (
                                    <span
                                        className={cn(
                                            'flex size-3 items-center justify-center',
                                            badge.checksToneClassName,
                                        )}
                                    >
                                        <ChecksIcon size={11} />
                                    </span>
                                )}
                            </button>
                        </Tooltip>
                    )}
                </span>
            </span>
        </li>
    );
}

/**
 * The Commander's hold on a Session as one tinted icon: its current task's status, tinted when the task needs someone,
 * with the status and what it means in the tooltip. In the whole-Workbench scope a Session the Commander created but
 * never delegated into shows a robot, so the Commander's rows stand out from the user's.
 */
function CommanderTaskIcon({
    showsOwnership,
    task,
}: {
    showsOwnership: boolean;
    task: ReturnType<typeof commanderTaskBadge>;
}) {
    const TaskIcon = task ? TASK_ICONS[task.icon] : Bot;
    const description = task?.title ?? 'Created by Agent Commander, so it can delegate tasks here.';
    const label = showsOwnership && task ? `Commander task. ${description}` : description;
    return (
        <Tooltip content={label}>
            <span
                role="img"
                aria-label={label}
                className={cn(
                    'commander-board-task relative flex size-3.5 flex-none items-center justify-center',
                    task?.toneClassName ?? 'text-muted',
                )}
                data-task-label={task?.label ?? 'Commander'}
            >
                <TaskIcon size={12} />
            </span>
        </Tooltip>
    );
}
