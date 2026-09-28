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
    Unplug,
} from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import type { AgentActivityGlyphId } from '../agent-activity/agent-activity-glyph';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import type { CommanderTaskIconId } from './commander-board';
import {
    commanderPullRequestBadge,
    commanderRowPresentation,
    commanderTaskBadge,
} from './commander-board';
import { openCommanderPullRequest, revealCommanderSession } from './commander-commands';

/**
 * The Activity view's glyph shapes, so a state looks the same in both windows.
 */
const GLYPH_COMPONENTS: Record<AgentActivityGlyphId, ComponentType<{ size?: number }>> = {
    check: CircleCheck,
    dashed: CircleDashed,
    hollow: Circle,
    question: CircleQuestionMark,
    spinner: Spinner,
    unplug: Unplug,
    x: CircleX,
};

const TASK_ICONS: Record<CommanderTaskIconId, ComponentType<{ size?: number }>> = {
    'answered': CheckCheck,
    'blocked': CircleAlert,
    'failed': CircleX,
    'running': CircleDot,
    'starting': LoaderCircle,
    'stopped': CircleStop,
    'taken-over': Hand,
};

/**
 * One board row. The whole row reveals its Session in the Workbench; the pull request chip is a separate control that
 * opens the pull request in the browser, stacked above the row's stretched hit area so the two never nest.
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
                        <CommanderTaskChip showsOwnership={showsOwnership} task={task} />
                    )}
                </span>
                <span className="commander-board-metadata flex h-4 min-w-0 items-center gap-1 text-[11px] leading-4 text-muted">
                    <span className="flex size-3 flex-none items-center justify-center">
                        <AgentIdentityIcon
                            identity={row.agent?.kind ?? 'shell'}
                            size={12}
                            tone="state"
                        />
                    </span>
                    <span className="sr-only">{presentation.agentLabel}</span>
                    <span className="overflow-fade min-w-0 shrink">{row.projectTitle}</span>
                    <span aria-hidden="true">·</span>
                    <span className="flex-none whitespace-nowrap">{presentation.statePhrase}</span>
                    <span aria-hidden="true">·</span>
                    <span className="flex-none whitespace-nowrap">
                        {relativeTime(row.lastActivityAt, now, 'narrow')}
                    </span>
                </span>
                {badge && (
                    <Tooltip content={badge.title}>
                        <button
                            type="button"
                            aria-label={badge.ariaLabel}
                            className="commander-board-pull-request relative flex h-4 max-w-full min-w-0 cursor-pointer items-center gap-1 self-start rounded text-[11px] leading-4 text-muted outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground"
                            onClick={() => openCommanderPullRequest(badge.url)}
                        >
                            <SessionPullRequestIndicator pullRequest={row.pullRequest} />
                            <span className="flex-none">{badge.numberLabel}</span>
                            <span className={cn('flex-none', badge.toneClassName)}>
                                {badge.stateLabel}
                            </span>
                            {badge.checksLabel && (
                                <>
                                    <span aria-hidden="true">·</span>
                                    <span
                                        className={cn(
                                            'overflow-fade min-w-0',
                                            badge.checksToneClassName,
                                        )}
                                    >
                                        {badge.checksLabel}
                                    </span>
                                </>
                            )}
                        </button>
                    </Tooltip>
                )}
            </span>
        </li>
    );
}

/**
 * The Commander's hold on a Session in one bordered chip: its current task's icon and status, tinted when the task
 * needs someone, so a status such as a takeover reads at a glance instead of blending into the title. In the
 * whole-Workbench scope it leads with `Commander`, so the Commander's rows stand out from the user's.
 */
function CommanderTaskChip({
    showsOwnership,
    task,
}: {
    showsOwnership: boolean;
    task: ReturnType<typeof commanderTaskBadge>;
}) {
    const TaskIcon = task ? TASK_ICONS[task.icon] : Bot;
    return (
        <Tooltip
            content={task?.title ?? 'Created by Agent Commander, so it can delegate tasks here.'}
        >
            <span
                className={cn(
                    'commander-board-task relative flex h-4 flex-none items-center gap-1 rounded border border-border px-1 text-[10px] leading-4 whitespace-nowrap',
                    task?.toneClassName ?? 'text-muted',
                )}
            >
                <TaskIcon size={10} />
                {showsOwnership && <span>{task ? 'Commander ·' : 'Commander'}</span>}
                {task && <span>{task.label}</span>}
            </span>
        </Tooltip>
    );
}
