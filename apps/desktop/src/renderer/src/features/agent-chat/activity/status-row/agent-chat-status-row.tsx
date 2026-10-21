import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import type { AgentChatTurnUsage } from '@caxri/protocol';
import { ChevronRight, CircleX, ListTodo } from 'lucide-react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/ui/popover';
import { Spinner } from '../../../../components/ui/spinner';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskStopButton } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { agentChatTaskTitle } from '../../tasks/agent-chat-tasks';
import { AgentChatTurnMetricList } from '../agent-chat-turn-metric-list';
import { AgentChatActivityLead } from './agent-chat-activity-lead';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import { AgentChatStatusDetails } from './agent-chat-status-details';
import { STATUS_ROW_SPRING, STATUS_ROW_SWAP } from './agent-chat-status-row-motion';
import type {
    AgentChatStatusRowSection,
    AgentChatStatusRowView,
} from './agent-chat-status-row-view';
import { agentChatFailuresText } from './agent-chat-status-row-view';

const BADGE_CLASS_NAME =
    'relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[11px] text-muted tabular-nums transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent';

const LEAD_TRIGGER_CLASS_NAME =
    'flex min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-left text-muted hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated';

/**
 * A red dot on a task glyph: a background task failed and the user has not looked at the task list since.
 */
function FailureDot({ children, isShown }: { children: ReactNode; isShown: boolean }) {
    return (
        <span className="relative inline-flex shrink-0">
            {children}
            {isShown && (
                <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-danger ring-1 ring-surface" />
            )}
        </span>
    );
}

/**
 * One of the row's two badges (plan, background work), pinned to the right edge so ticking figures never move the click
 * target. It pops in and out rather than blinking, and while the popover shows its section a pill sits behind it,
 * sliding to the other badge when the user switches.
 */
function StatusBadge({
    children,
    isActive,
    label,
    pillId,
    onClick,
}: {
    children: ReactNode;
    isActive: boolean;
    label: string;
    /**
     * The `layoutId` both badges share, so the pill slides between them.
     */
    pillId: string;
    onClick: () => void;
}) {
    return (
        <m.span
            animate={{
                opacity: 1,
                scale: 1,
                filter: 'blur(0px)',
                transitionEnd: { filter: 'none' },
            }}
            className="inline-flex shrink-0"
            exit={{ opacity: 0, scale: 0.85, filter: 'blur(2px)' }}
            initial={{ opacity: 0, scale: 0.85, filter: 'blur(2px)' }}
            layout="position"
            transition={STATUS_ROW_SWAP.transition}
        >
            <PopoverTrigger
                aria-label={label}
                className={cn(BADGE_CLASS_NAME, isActive && 'text-foreground')}
                onClick={onClick}
            >
                <AnimatePresence>
                    {isActive && (
                        <m.span
                            animate={{ opacity: 1 }}
                            className="absolute inset-0 rounded-md bg-elevated"
                            exit={{ opacity: 0 }}
                            initial={{ opacity: 0 }}
                            layoutId={pillId}
                            transition={STATUS_ROW_SPRING}
                        />
                    )}
                </AnimatePresence>
                <span className="relative inline-flex items-center gap-1">{children}</span>
            </PopoverTrigger>
        </m.span>
    );
}

/**
 * The single status row above the composer input (`agentChatStatusRowView`). The left side leads with the turn while
 * the Chat is busy, and after the turn with what still needs the user: a running background task inline with its Stop,
 * a count of several, unseen failures, or an unfinished plan. The right side holds the turn's usage as bare figures and
 * the plan and background work badges. Both badges and the task leads open one popover anchored to the row, showing
 * exactly the clicked section; they open on click only, because a hover-opened popup takes focus and would swallow the
 * Escape that stops the turn. A failure counts as seen once the user opened the task list and closed it again: marking
 * it on open would drop a failures-only row from under its own popover, and opening the plan never clears it.
 */
export function AgentChatStatusRow({
    isStopping,
    isTurnRunning,
    terminalId,
    turnId,
    usage,
    view,
    onOpenTask,
    onPopoverClosed,
}: {
    isStopping: boolean;
    isTurnRunning: boolean;
    terminalId: string;
    turnId: string | undefined;
    usage: AgentChatTurnUsage | undefined;
    view: AgentChatStatusRowView;
    onOpenTask: ((taskId: string) => void) | undefined;
    /**
     * Where focus goes when the popover closes by pointer or because the row left: the composer input, since a closed
     * popover's trigger may be gone with its row. A keyboard close returns focus to the trigger instead.
     */
    onPopoverClosed: () => HTMLElement | null;
}) {
    const { t } = useTranslation();
    const rowReference = useRef<HTMLDivElement>(null);
    const pillId = useId();
    const [isOpen, setOpen] = useState(false);
    const [section, setSection] = useState<AgentChatStatusRowSection>('plan');
    /**
     * The failures listed while the user had the task list open: closing the popover marks exactly these seen, not one
     * that ended while it was open on another section.
     */
    const [viewedFailureIds, setViewedFailureIds] = useState<readonly string[]>([]);
    // While the row folds away it still renders its last props; close the popover then, or a row that comes back
    // mid-fold would revive it open. A fold is not the user closing the list, so nothing it showed counts as seen.
    const isPresent = useIsPresent();
    if (!isPresent && isOpen) {
        setOpen(false);
        setViewedFailureIds([]);
    }

    const show = (next: AgentChatStatusRowSection) => (): void => {
        setSection(next);
        if (next !== 'tasks') return;
        setViewedFailureIds((viewed) => [
            ...new Set([...viewed, ...view.failed.map(({ id }) => id)]),
        ]);
    };
    const changeOpen = (isOpenNext: boolean): void => {
        setOpen(isOpenNext);
        if (isOpenNext || viewedFailureIds.length === 0) return;
        setViewedFailureIds([]);
        markAgentChatFailuresSeen(terminalId, viewedFailureIds);
    };
    const isViewingTasks = isOpen && section === 'tasks';
    const failureCount = view.unseenFailureIds.length;
    const isShowsFailureDot = failureCount > 0 && !isViewingTasks;
    const failureText = agentChatFailuresText(failureCount, t);
    const { lead, planBadge, taskBadge } = view;

    let leadContent: ReactNode;
    switch (lead.kind) {
        case 'activity': {
            leadContent = (
                <AgentChatActivityLead
                    activity={lead.activity}
                    isStopping={isStopping}
                    turnId={turnId}
                />
            );
            break;
        }
        case 'task': {
            const title = agentChatTaskTitle(lead.task, t);
            leadContent = (
                <>
                    <PopoverTrigger
                        aria-label={t('agentChat.status.showDetails', {
                            status: t('agentChat.status.taskRunning', { title }),
                        })}
                        className={cn(LEAD_TRIGGER_CLASS_NAME, 'flex-1')}
                        onClick={show('tasks')}
                    >
                        <FailureDot isShown={isShowsFailureDot}>
                            <AgentChatTaskGlyph kind={lead.task.kind} />
                        </FailureDot>
                        <span
                            className={cn(
                                'min-w-0 truncate text-foreground',
                                lead.task.kind === 'shell' && 'font-mono text-[11px]',
                            )}
                        >
                            {title}
                        </span>
                        <Spinner className="ml-auto size-3.5 shrink-0" role="presentation" />
                    </PopoverTrigger>
                    <AgentChatTaskStopButton task={lead.task} terminalId={terminalId} />
                </>
            );
            break;
        }
        case 'tasks': {
            const text = t('agentChat.status.tasksRunning', { count: lead.count });
            leadContent = (
                <PopoverTrigger
                    aria-label={t('agentChat.status.showDetails', { status: text })}
                    className={LEAD_TRIGGER_CLASS_NAME}
                    onClick={show('tasks')}
                >
                    <FailureDot isShown={isShowsFailureDot}>
                        <AgentChatTaskGlyph kind={view.running[0]?.kind ?? 'agent'} />
                    </FailureDot>
                    <span className="truncate text-foreground">{text}</span>
                    <Spinner className="size-3.5 shrink-0" role="presentation" />
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                </PopoverTrigger>
            );
            break;
        }
        case 'failures': {
            leadContent = (
                <PopoverTrigger
                    aria-label={t('agentChat.status.showDetails', { status: failureText })}
                    className={LEAD_TRIGGER_CLASS_NAME}
                    onClick={show('tasks')}
                >
                    <CircleX aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
                    <span className="truncate text-danger">{failureText}</span>
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                </PopoverTrigger>
            );
            break;
        }
        case 'plan': {
            const { completed, total, current } = lead.progress;
            const text = t('agentChat.status.planStopped', { completed, total });
            leadContent = (
                <PopoverTrigger
                    aria-label={t('agentChat.status.showDetails', {
                        status: current ? `${text}: ${current}` : text,
                    })}
                    className={LEAD_TRIGGER_CLASS_NAME}
                    onClick={show('plan')}
                >
                    <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="shrink-0 tabular-nums">{text}</span>
                    {current && <span className="min-w-0 truncate">{current}</span>}
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                </PopoverTrigger>
            );
            break;
        }
    }

    const taskSummary = taskBadge && [
        taskBadge.running > 0 && t('agentChat.tasks.runningCount', { count: taskBadge.running }),
        taskBadge.unseenFailures > 0 && failureText,
    ];
    return (
        <Popover open={isOpen} onOpenChange={changeOpen}>
            <div
                className={cn(
                    '@container flex h-8 items-center gap-2 pr-1.5 text-[12px] text-muted',
                    lead.kind === 'activity' ? 'pl-3' : 'pl-1.5',
                )}
                data-agent-chat-status-row={lead.kind}
                ref={rowReference}
            >
                {leadContent}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1.5">
                    {lead.kind === 'activity' && (
                        <span aria-hidden="true" className="inline-flex">
                            <AgentChatTurnMetricList usage={usage} />
                        </span>
                    )}
                    <span className="flex shrink-0 items-center gap-0.5">
                        <AnimatePresence initial={false} mode="popLayout">
                            {planBadge && (
                                <StatusBadge
                                    isActive={isOpen && section === 'plan'}
                                    key="plan"
                                    label={t(
                                        planBadge.current
                                            ? 'agentChat.plan.progressWithCurrent'
                                            : 'agentChat.plan.progress',
                                        {
                                            completed: planBadge.completed,
                                            total: planBadge.total,
                                            current: planBadge.current ?? '',
                                        },
                                    )}
                                    pillId={pillId}
                                    onClick={show('plan')}
                                >
                                    <ListTodo aria-hidden="true" className="size-3.5" />
                                    {planBadge.completed}/{planBadge.total}
                                </StatusBadge>
                            )}
                            {taskBadge && (
                                <StatusBadge
                                    isActive={isViewingTasks}
                                    key="tasks"
                                    label={t('agentChat.status.tasksBadge', {
                                        summary: taskSummary?.filter(Boolean).join(', ') ?? '',
                                    })}
                                    pillId={pillId}
                                    onClick={show('tasks')}
                                >
                                    {taskBadge.running > 0 ? (
                                        <FailureDot isShown={isShowsFailureDot}>
                                            <AgentChatTaskGlyph
                                                kind={view.running[0]?.kind ?? 'agent'}
                                            />
                                        </FailureDot>
                                    ) : (
                                        <CircleX
                                            aria-hidden="true"
                                            className="size-3.5 text-danger"
                                        />
                                    )}
                                    {taskBadge.running > 0
                                        ? taskBadge.running
                                        : taskBadge.unseenFailures}
                                </StatusBadge>
                            )}
                        </AnimatePresence>
                    </span>
                </span>
            </div>
            <PopoverContent
                align="end"
                anchor={rowReference}
                className="w-[min(28rem,var(--anchor-width))] p-0"
                finalFocus={(closeType) => closeType === 'keyboard' || onPopoverClosed()}
                side="top"
                sideOffset={6}
            >
                <AgentChatStatusDetails
                    isTurnRunning={isTurnRunning}
                    section={section}
                    terminalId={terminalId}
                    view={view}
                    onOpenTask={onOpenTask}
                />
            </PopoverContent>
        </Popover>
    );
}
