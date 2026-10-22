import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import type { AgentChatTurnUsage } from '@caxri/protocol';
import { CircleX, ListTodo } from 'lucide-react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/ui/popover';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { AgentChatTurnMetricList } from '../agent-chat-turn-metric-list';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import { AgentChatStatusDetails } from './agent-chat-status-details';
import { AgentChatStatusRowLead, FailureDot } from './agent-chat-status-row-lead';
import { STATUS_ROW_SPRING, STATUS_ROW_SWAP } from './agent-chat-status-row-motion';
import type {
    AgentChatStatusRowSection,
    AgentChatStatusRowView,
} from './agent-chat-status-row-view';
import {
    agentChatFailuresText,
    agentChatPlanBadgeLabel,
    agentChatTaskBadgeLabel,
} from './agent-chat-status-row-view';

const BADGE_CLASS_NAME =
    'relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[11px] text-muted tabular-nums transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent';

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
 * The background work badge's glyph and figure: the running tasks' glyph and count (with the failure dot), or a red
 * cross and the unseen failures once nothing runs.
 */
function TaskBadgeContent({
    badge,
    isShowsFailureDot,
    running,
}: {
    badge: NonNullable<AgentChatStatusRowView['taskBadge']>;
    isShowsFailureDot: boolean;
    running: AgentChatStatusRowView['running'];
}) {
    if (badge.running === 0) {
        return (
            <>
                <CircleX aria-hidden="true" className="size-3.5 text-danger" />
                {badge.unseenFailures}
            </>
        );
    }
    return (
        <>
            <FailureDot isShown={isShowsFailureDot}>
                <AgentChatTaskGlyph kind={running[0]?.kind ?? 'agent'} />
            </FailureDot>
            {badge.running}
        </>
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
                <AgentChatStatusRowLead
                    failureText={failureText}
                    isShowsFailureDot={isShowsFailureDot}
                    isStopping={isStopping}
                    lead={lead}
                    running={view.running}
                    terminalId={terminalId}
                    turnId={turnId}
                    onShow={show}
                />
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1.5">
                    {lead.kind === 'activity' && <AgentChatTurnMetricList usage={usage} />}
                    <span className="flex shrink-0 items-center gap-0.5">
                        <AnimatePresence initial={false} mode="popLayout">
                            {planBadge && (
                                <StatusBadge
                                    isActive={isOpen && section === 'plan'}
                                    key="plan"
                                    label={agentChatPlanBadgeLabel(planBadge, t)}
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
                                    label={agentChatTaskBadgeLabel(taskBadge, t)}
                                    pillId={pillId}
                                    onClick={show('tasks')}
                                >
                                    <TaskBadgeContent
                                        badge={taskBadge}
                                        isShowsFailureDot={isShowsFailureDot}
                                        running={view.running}
                                    />
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
