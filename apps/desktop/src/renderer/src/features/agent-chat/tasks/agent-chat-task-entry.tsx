import type { AgentChatTask } from '@caxri/protocol';
import {
    agentChatTaskGlyphStatus,
    canStopAgentChatTask,
    isAgentChatTaskTitleCommand,
} from '@caxri/protocol';
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
import { AgentChatStatusGlyph } from '../tools/agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { agentChatTaskTitle } from './agent-chat-tasks';

const TASK_ENTRY_CLASS_NAME =
    'flex min-w-0 flex-1 items-center gap-2 rounded border-0 bg-transparent px-2 py-0.5 text-left text-muted';

/**
 * Stops one background task. While the stop is pending it spins and refuses clicks; `aria-disabled` rather than
 * `disabled` keeps a keyboard user's focus on it.
 */
export function AgentChatTaskStopButton({
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
 * One background task in the status row's task list: its kind, title, elapsed time, and status, opening its side tab on
 * click where the host can open one, with Stop while it runs. Stopping the turn with Esc never stops it.
 */
export function AgentChatTaskEntry({
    task,
    terminalId,
    onOpenTask,
}: {
    task: AgentChatTask;
    terminalId: string;
    /**
     * Opens the task's tab beside the Chat; absent where the host cannot, which leaves the task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const title = agentChatTaskTitle(task, t);
    const summary = (
        <>
            <AgentChatTaskGlyph kind={task.kind} />
            <span
                className={
                    isAgentChatTaskTitleCommand(task)
                        ? 'min-w-0 truncate font-mono text-[11px] text-foreground'
                        : 'min-w-0 truncate text-foreground'
                }
            >
                {title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
                <AgentChatTaskElapsed task={task} />
                {task.status === 'running' ? (
                    <Spinner className="size-3.5" role="presentation" />
                ) : (
                    <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                )}
            </span>
        </>
    );
    return (
        <li
            className={cn(
                'flex min-w-0 items-center gap-1 rounded text-[12px] leading-5',
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
                // A host that cannot open the task's tab (the Agent Commander window) lists the task as plain text.
                <div className={TASK_ENTRY_CLASS_NAME}>{summary}</div>
            )}
            {canStopAgentChatTask(task) && (
                <AgentChatTaskStopButton task={task} terminalId={terminalId} />
            )}
        </li>
    );
}
