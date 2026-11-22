import type { AgentChatTask } from '@caxri/protocol';
import { agentChatTaskGlyphStatus, canStopAgentChatTask } from '@caxri/protocol';
import { Square } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import {
    agentChatTaskKey,
    stopAgentChatTask,
    useAgentChatTaskStopStore,
} from '../agent-chat-commands';
import { AgentChatStripDismissButton } from '../composer/strip/agent-chat-strip-dismiss-button';
import { AgentChatStripRowSlot } from '../composer/strip/agent-chat-strip-row-slot';
import { AgentChatStatusGlyph } from '../tools/agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { agentChatTaskTitle, agentChatTaskTitleParts } from './agent-chat-tasks';
import { AgentChatWorkflowProgress } from './workflow/agent-chat-workflow-progress';

const TASK_ENTRY_CLASS_NAME =
    'flex min-w-0 flex-1 items-center gap-2 rounded border-0 bg-transparent px-2 py-0.5 text-left text-muted';

/**
 * Stops one background task. While the stop is pending it spins and refuses clicks; `aria-disabled` rather than
 * `disabled` keeps a keyboard user's focus on it.
 */
function AgentChatTaskStopButton({
    task,
    terminalId,
}: {
    task: AgentChatTask;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        stopping.has(agentChatTaskKey(terminalId, task.id)),
    );
    return (
        <Tooltip content={t(isStopping ? 'agentChat.tasks.stopping' : 'agentChat.tasks.stop')}>
            <Button
                aria-busy={isStopping || undefined}
                aria-disabled={isStopping || undefined}
                aria-label={t('agentChat.tasks.stopTask', { title: agentChatTaskTitle(task, t) })}
                className="size-6 shrink-0 text-muted hover:text-foreground aria-busy:cursor-progress aria-busy:opacity-100"
                size="icon"
                variant="ghost"
                onClick={() => {
                    if (!isStopping) stopAgentChatTask(terminalId, task.id);
                }}
            >
                {isStopping ? (
                    <Spinner className="size-3.5" role="presentation" />
                ) : (
                    <Square aria-hidden="true" className="size-2.5 fill-current" />
                )}
            </Button>
        </Tooltip>
    );
}

/**
 * One background task in the composer strip's Background work list: its kind, title, progress (a workflow run), elapsed
 * time, and status, opening its side tab on click where the host can open one. Its status glyph gives way to Stop while
 * it runs, or to Dismiss for a failure the user was shown (`onDismiss`), whenever the pointer or focus is on the row.
 * Stopping the turn with Esc never stops it.
 */
export function AgentChatTaskEntry({
    task,
    terminalId,
    onDismiss,
    onOpenTask,
}: {
    task: AgentChatTask;
    terminalId: string;
    /**
     * Dismisses a failed task from the list; absent for a task that cannot be dismissed.
     */
    onDismiss?: () => void;
    /**
     * Opens the task's tab beside the Chat; absent where the host cannot, which leaves the task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { text: title, isCode } = agentChatTaskTitleParts(task, t);
    const summary = (
        <>
            <AgentChatTaskGlyph isWorkflow={task.workflow !== undefined} kind={task.kind} />
            <span
                className={
                    isCode
                        ? 'min-w-0 truncate font-mono text-[11px] text-foreground'
                        : 'min-w-0 truncate text-foreground'
                }
            >
                {title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
                {task.workflow && (
                    <AgentChatWorkflowProgress
                        isRunning={task.status === 'running'}
                        workflow={task.workflow}
                    />
                )}
                <AgentChatTaskElapsed task={task} />
            </span>
        </>
    );
    return (
        <li
            className={cn(
                'group/row flex min-w-0 items-center gap-1 rounded text-[12px] leading-5',
                onOpenTask && 'hover:bg-list-hover-background',
            )}
        >
            {onOpenTask ? (
                <button
                    aria-label={t('agentChat.tasks.openTask', { title })}
                    className={cn(
                        TASK_ENTRY_CLASS_NAME,
                        'cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-accent',
                    )}
                    type="button"
                    onClick={() => onOpenTask(task.id)}
                >
                    {summary}
                </button>
            ) : (
                // A host that cannot open the task's tab (Caxri Bot window) lists the task as plain text.
                <div className={TASK_ENTRY_CLASS_NAME}>{summary}</div>
            )}
            <AgentChatStripRowSlot
                action={
                    canStopAgentChatTask(task) ? (
                        <AgentChatTaskStopButton task={task} terminalId={terminalId} />
                    ) : onDismiss ? (
                        <AgentChatStripDismissButton title={title} onDismiss={onDismiss} />
                    ) : undefined
                }
                glyph={
                    task.status === 'running' ? (
                        <Spinner className="size-3.5 text-muted" role="presentation" />
                    ) : (
                        <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                    )
                }
            />
        </li>
    );
}
