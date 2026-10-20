import { useId, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import {
    agentChatTaskGlyphStatus,
    agentChatTaskStripView,
    canStopAgentChatTask,
    isAgentChatTaskTitleCommand,
} from '@caxri/protocol';
import { ChevronRight, Square } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    agentChatTaskKey,
    stopAgentChatTask,
    useAgentChatTaskStopStore,
} from './agent-chat-commands';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';

const TASK_ENTRY_CLASS_NAME =
    'flex min-w-0 flex-1 items-center gap-2 rounded border-0 bg-transparent px-2 py-0.5 text-left text-muted';

function TaskEntry({
    task,
    terminalId,
    onOpenTask,
}: {
    task: AgentChatTask;
    terminalId: string;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        stopping.has(agentChatTaskKey(terminalId, task.id)),
    );
    const title =
        task.title ||
        t(task.kind === 'shell' ? 'agentChat.tasks.shell' : 'agentChat.tasks.subagent');
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
                'group/task flex min-w-0 items-center gap-1 rounded text-[12px] leading-5',
                onOpenTask && 'hover:bg-[var(--selection)]',
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
                <Tooltip
                    content={t(isStopping ? 'agentChat.tasks.stopping' : 'agentChat.tasks.stop')}
                >
                    <Button
                        aria-busy={isStopping || undefined}
                        aria-disabled={isStopping || undefined}
                        aria-label={t('agentChat.tasks.stopTask', { title })}
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
            )}
        </li>
    );
}

/**
 * Background work, the top section of the composer's strip: each running subagent and background shell with its elapsed
 * time, opened in its side tab on click (where the host can open one) and stoppable on its own. Stopping the turn with
 * Esc never stops these. Ended work is counted, and the count reveals it (most recent first, with how each ended) so a
 * task that just finished is one click from its tab without hunting for its timeline row. Once the last task ends the
 * strip disappears (`agentChatTaskStripView`): the Agent reports the result in the conversation, and each task's
 * timeline row still opens it.
 */
export function AgentChatTaskStrip({
    tasks,
    terminalId,
    onOpenTask,
}: {
    tasks: readonly AgentChatTask[] | undefined;
    terminalId: string;
    /**
     * Opens a task's tab beside the Chat; absent where the host cannot, which leaves each task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const view = agentChatTaskStripView(tasks);
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    if (!view) return null;
    const { running, ended } = view;
    return (
        <section
            aria-label={t('agentChat.tasks.backgroundWork')}
            className="border-0 border-b border-solid border-border p-1"
            data-agent-chat-composer-strip-row=""
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 px-2 text-[11px] font-normal text-muted">
                <span className="min-w-0 flex-1 truncate">
                    {t('agentChat.tasks.backgroundWork')}
                </span>
                <span className="shrink-0 tabular-nums">
                    {t('agentChat.tasks.runningCount', { count: running.length })}
                    {ended.length > 0 && ' · '}
                    {ended.length > 0 && (
                        <button
                            aria-controls={endedListId}
                            aria-expanded={isShowingEnded}
                            className="inline-flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 align-middle text-muted tabular-nums hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                            type="button"
                            onClick={() => setShowingEnded((value) => !value)}
                        >
                            {t('agentChat.tasks.endedCount', { count: ended.length })}
                            {/* The count reads as plain status text without a disclosure cue. */}
                            <ChevronRight
                                aria-hidden="true"
                                className={cn(
                                    'size-3 shrink-0',
                                    agentChatChevronMotion(isShowingEnded),
                                    isShowingEnded && 'rotate-90',
                                )}
                            />
                        </button>
                    )}
                </span>
            </h3>
            <ul className="m-0 flex max-h-32 list-none flex-col overflow-y-auto p-0">
                {running.map((task) => (
                    <TaskEntry
                        key={task.id}
                        task={task}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                ))}
            </ul>
            <DisclosureMotion
                animate
                expanded={isShowingEnded && ended.length > 0}
                id={endedListId}
                kind="agent-chat-ended-tasks"
            >
                <ul
                    aria-label={t('agentChat.tasks.endedList')}
                    className="m-0 mt-1 flex max-h-32 list-none flex-col overflow-y-auto border-t border-border p-0 pt-1"
                >
                    {ended.map((task) => (
                        <TaskEntry
                            key={task.id}
                            task={task}
                            terminalId={terminalId}
                            onOpenTask={onOpenTask}
                        />
                    ))}
                </ul>
            </DisclosureMotion>
        </section>
    );
}
