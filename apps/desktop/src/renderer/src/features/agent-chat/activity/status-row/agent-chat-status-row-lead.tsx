import type { ReactNode } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { ChevronRight, CircleX, ListTodo } from 'lucide-react';

import { PopoverTrigger } from '../../../../components/ui/popover';
import { Spinner } from '../../../../components/ui/spinner';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskStopButton } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { agentChatTaskTitle } from '../../tasks/agent-chat-tasks';
import { AgentChatActivityLead } from './agent-chat-activity-lead';
import type {
    AgentChatStatusRowSection,
    AgentChatStatusRowView,
} from './agent-chat-status-row-view';

const LEAD_TRIGGER_CLASS_NAME =
    'flex min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-left text-muted hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated';

/**
 * A red dot on a task glyph: a background task failed and the user has not looked at the task list since.
 */
export function FailureDot({ children, isShown }: { children: ReactNode; isShown: boolean }) {
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
 * The status row's left side (`AgentChatStatusRowView['lead']`): the turn's activity while the Chat is busy, else the
 * trigger that opens what still needs the user (a running task beside its Stop, a count of several, unseen failures, or
 * an unfinished plan).
 */
export function AgentChatStatusRowLead({
    failureText,
    isShowsFailureDot,
    isStopping,
    lead,
    running,
    terminalId,
    turnId,
    onShow: show,
}: {
    failureText: string;
    isShowsFailureDot: boolean;
    isStopping: boolean;
    lead: AgentChatStatusRowView['lead'];
    running: readonly AgentChatTask[];
    terminalId: string;
    turnId: string | undefined;
    /**
     * Picks the popover section a trigger opens.
     */
    onShow: (section: AgentChatStatusRowSection) => () => void;
}) {
    const { t } = useTranslation();
    switch (lead.kind) {
        case 'activity': {
            return (
                <AgentChatActivityLead
                    activity={lead.activity}
                    isStopping={isStopping}
                    turnId={turnId}
                />
            );
        }
        case 'task': {
            const title = agentChatTaskTitle(lead.task, t);
            return (
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
        }
        case 'tasks': {
            const text = t('agentChat.status.tasksRunning', { count: lead.count });
            return (
                <PopoverTrigger
                    aria-label={t('agentChat.status.showDetails', { status: text })}
                    className={LEAD_TRIGGER_CLASS_NAME}
                    onClick={show('tasks')}
                >
                    <FailureDot isShown={isShowsFailureDot}>
                        <AgentChatTaskGlyph kind={running[0]?.kind ?? 'agent'} />
                    </FailureDot>
                    <span className="truncate text-foreground">{text}</span>
                    <Spinner className="size-3.5 shrink-0" role="presentation" />
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                </PopoverTrigger>
            );
        }
        case 'failures': {
            return (
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
        }
        case 'plan': {
            const { completed, total, current } = lead.progress;
            const text = t('agentChat.status.planStopped', { completed, total });
            return (
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
        }
    }
}
