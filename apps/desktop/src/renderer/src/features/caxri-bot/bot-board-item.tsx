import type { ComponentType } from 'react';

import type { BotBoardRow } from '@caxri/protocol';
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
    Clock,
    Hand,
    HandHelping,
    LoaderCircle,
    Moon,
    Power,
    TriangleAlert,
    Unplug,
    ZapOff,
} from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { caxriBot as englishCaxriBot } from '../../i18n/locales/en/caxri-bot';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { localizedRelativeTime } from '../../lib/relative-time';
import { cn } from '../../lib/utilities';
import type { AgentActivityGlyphId } from '../agent-activity/agent-activity-glyph';
import { BackgroundArc, RunningArc } from '../primary-sidebar/running-arc';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import { sessionTitleForDisplay } from '../session/session-title';
import type { BotChecksIconId, BotProcessIconId, BotTaskIconId } from './bot-board';
import {
    botHandoverDescription,
    botPullRequestBadge,
    botRowPresentation,
    botTaskBadge,
} from './bot-board';
import { openBotPullRequest, revealBotSession } from './bot-commands';

type IconComponent = ComponentType<{ size?: number }>;

/**
 * The Activity view's glyph shapes, so a state looks the same in both windows. A running turn draws the
 * PrimarySidebar's running ring rather than the Activity view's spinner, because the board lists the same Sessions as
 * the sidebar.
 */
const GLYPH_COMPONENTS: Record<AgentActivityGlyphId, IconComponent> = {
    background: BackgroundArc,
    check: CircleCheck,
    clock: Clock,
    dashed: CircleDashed,
    hollow: Circle,
    question: CircleQuestionMark,
    spinner: RunningArc,
    unplug: Unplug,
    x: CircleX,
};

const TASK_ICONS: Record<BotTaskIconId, IconComponent> = {
    'answered': CheckCheck,
    'blocked': CircleAlert,
    'failed': CircleX,
    'running': CircleDot,
    'starting': LoaderCircle,
    'stopped': CircleStop,
    'taken-over': Hand,
};

const PROCESS_ICONS: Record<BotProcessIconId, IconComponent> = {
    exited: Power,
    failed: TriangleAlert,
    interrupted: ZapOff,
    starting: LoaderCircle,
    suspended: Moon,
};

const CHECKS_ICONS: Record<BotChecksIconId, IconComponent> = {
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
export function BotBoardItem({
    now,
    row,
    showsOwnership,
}: {
    now: number;
    row: BotBoardRow;
    /**
     * Marks Caxri Bot's own Sessions. Only the whole-Workbench scope needs it; the default scope lists nothing else.
     */
    showsOwnership: boolean;
}) {
    const { locale, t } = useTranslation();
    const presentation = botRowPresentation(row, t);
    const badge = botPullRequestBadge(row, t);
    const task = botTaskBadge(row.task, t);
    const handover = botHandoverDescription(row.handover, t);
    const GlyphIcon = GLYPH_COMPONENTS[presentation.glyph];
    const ProcessIcon = presentation.processIcon && PROCESS_ICONS[presentation.processIcon];
    const ChecksIcon = badge?.checksIcon && CHECKS_ICONS[badge.checksIcon];
    return (
        <li
            className={cn(
                'bot-board-item relative flex items-start gap-2 rounded-md px-2 py-1.5 text-foreground',
                // The shared `--list-*` row states, as the Hand Over dialog's rows paint them, so an imported theme
                // reaches the board too. Keyboard focus takes the focus state; hover never paints over it.
                'hover:bg-list-hover-background hover:text-list-hover-foreground',
                'has-[.bot-board-reveal:focus-visible]:bg-list-focus-background has-[.bot-board-reveal:focus-visible]:text-list-focus-foreground',
            )}
            data-bot-group={row.group}
            data-session-id={row.sessionId}
        >
            <span
                role="img"
                aria-label={presentation.glyphLabel}
                className={cn(
                    'bot-board-glyph mt-0.5 flex size-3.5 flex-none items-center justify-center',
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
                        className="bot-board-reveal min-w-0 cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-md"
                        onClick={() => revealBotSession(row.sessionId)}
                    >
                        {sessionTitleForDisplay(row.sessionTitle, t)}
                    </button>
                    {row.botSession &&
                        (task !== undefined || handover !== undefined || showsOwnership) && (
                            <BotTaskIcon
                                handover={handover}
                                showsOwnership={showsOwnership}
                                task={task}
                            />
                        )}
                    <span className="bot-board-time ml-auto flex-none pl-1 text-[11px] whitespace-nowrap text-muted tabular-nums">
                        {localizedRelativeTime(row.lastActivityAt, now, 'narrow', locale)}
                    </span>
                </span>
                <span className="bot-board-metadata flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted">
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
                                className="bot-board-process relative flex size-3 flex-none items-center justify-center"
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
                                className="bot-board-pull-request relative ml-auto flex h-4 flex-none cursor-pointer items-center gap-0.5 rounded-md pl-1 text-[11px] leading-4 text-muted tabular-nums outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground"
                                onClick={() => openBotPullRequest(badge.url)}
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
 * Caxri Bot's hold on a Session as one tinted icon: its current task's status, tinted when the task needs someone, with
 * the status and what it means in the tooltip. A Session the user handed over and Caxri Bot has not continued yet shows
 * a helping hand. In the whole-Workbench scope a Session Caxri Bot created but never delegated into shows a robot, so
 * Caxri Bot's rows stand out from the user's.
 */
function BotTaskIcon({
    handover,
    showsOwnership,
    task,
}: {
    handover: string | undefined;
    showsOwnership: boolean;
    task: ReturnType<typeof botTaskBadge>;
}) {
    const { t } = useTranslation();
    const TaskIcon = task ? TASK_ICONS[task.icon] : handover ? HandHelping : Bot;
    const description = task?.title ?? handover ?? t('caxriBot.board.ownedSession');
    const label =
        showsOwnership && task ? t('caxriBot.board.botTask', { description }) : description;
    return (
        <Tooltip content={label}>
            <span
                role="img"
                aria-label={label}
                className={cn(
                    'bot-board-task relative flex size-3.5 flex-none items-center justify-center',
                    task?.toneClassName ?? 'text-muted',
                )}
                // A stable English value in every locale: E2E and diagnostics match on it.
                data-task-label={
                    task
                        ? englishCaxriBot[task.labelKey as keyof typeof englishCaxriBot]
                        : handover
                          ? 'Handed over'
                          : 'Caxri Bot'
                }
            >
                <TaskIcon size={12} />
            </span>
        </Tooltip>
    );
}
