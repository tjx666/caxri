import { useId, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { canStopAgentChatTask } from '@caxri/protocol';
import { Layers, Square, X } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import {
    agentChatTaskKey,
    stopAgentChatTasks,
    useAgentChatTaskStopStore,
} from '../../agent-chat-commands';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import { agentChatTaskTitle } from '../../tasks/agent-chat-tasks';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from './agent-chat-strip-folds';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatBackgroundWork } from './agent-chat-strip-sections';
import {
    agentChatBackgroundWorkCounts,
    agentChatBackgroundWorkFoldedTask,
    agentChatBackgroundWorkSoleTask,
} from './agent-chat-strip-sections';

/**
 * The `Ended N` disclosure among the section's actions: beside a lone task's Stop, or in a headed section's header
 * before Stop all, so ended work never costs a row of its own. Folding finished tasks behind one quiet control follows
 * Synara and Claude Code's `Completed` group.
 */
function EndedTasksToggle({
    count,
    isShowing,
    listId,
    onToggle,
}: {
    count: number;
    isShowing: boolean;
    listId: string;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip content={t(isShowing ? 'agentChat.tasks.hideEnded' : 'agentChat.tasks.showEnded')}>
            <Button
                aria-controls={listId}
                aria-expanded={isShowing}
                className={cn(
                    'h-6 shrink-0 px-1.5 text-[11px] text-muted tabular-nums hover:text-foreground',
                    isShowing && 'text-foreground',
                )}
                size="sm"
                variant="ghost"
                onClick={onToggle}
            >
                {t('agentChat.tasks.endedCount', { count })}
            </Button>
        </Tooltip>
    );
}

/**
 * Stops every running task that can be stopped, shown once there are at least two (one task has its own Stop). No
 * confirmation, the same as each task's Stop. While every stop is pending it spins and refuses clicks; `aria-disabled`
 * rather than `disabled` keeps a keyboard user's focus on it.
 */
function StopAllTasksButton({
    taskIds,
    terminalId,
}: {
    taskIds: readonly string[];
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        taskIds.every((taskId) => stopping.has(agentChatTaskKey(terminalId, taskId))),
    );
    return (
        <Button
            aria-busy={isStopping || undefined}
            aria-disabled={isStopping || undefined}
            className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted hover:text-foreground aria-busy:cursor-progress"
            size="sm"
            variant="ghost"
            onClick={() => {
                if (!isStopping) stopAgentChatTasks(terminalId, taskIds);
            }}
        >
            {isStopping ? (
                <Spinner className="size-3" role="presentation" />
            ) : (
                <Square aria-hidden="true" className="size-2 fill-current" />
            )}
            {t('agentChat.tasks.stopAll')}
        </Button>
    );
}

/**
 * The ended tasks, most recent first, revealed by `EndedTasksToggle`.
 */
function EndedTasksList({
    expanded,
    listId,
    tasks,
    terminalId,
    onOpenTask,
}: {
    expanded: boolean;
    listId: string;
    tasks: readonly AgentChatTask[];
    terminalId: string;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    return (
        <DisclosureMotion animate expanded={expanded} id={listId} kind="agent-chat-ended-tasks">
            <ul
                aria-label={t('agentChat.tasks.endedList')}
                className="m-0 mt-1 flex max-h-32 list-none flex-col overflow-y-auto border-0 border-t border-solid border-border p-0 pt-1"
            >
                {tasks.map((task) => (
                    <AgentChatTaskEntry
                        key={task.id}
                        task={task}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                ))}
            </ul>
        </DisclosureMotion>
    );
}

/**
 * Background work with a single running task and no failure: that task's row is the whole section, with the ended
 * toggle beside its Stop, since a `Background work · 1 running` header would only repeat the row under it. There is
 * nothing to fold, so the section's fold state does not apply.
 */
function SoleTaskSection({
    ended,
    task,
    terminalId,
    onOpenTask,
}: {
    ended: readonly AgentChatTask[];
    task: AgentChatTask;
    terminalId: string;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    return (
        <section
            aria-label={t('agentChat.tasks.backgroundWork')}
            className="border-0 border-b border-solid border-border"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-strip-section="tasks"
        >
            <div className="flex min-h-8 items-center gap-1 px-1">
                <ul className="m-0 flex min-w-0 flex-1 list-none flex-col p-0">
                    <AgentChatTaskEntry
                        task={task}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                </ul>
                {ended.length > 0 && (
                    <EndedTasksToggle
                        count={ended.length}
                        isShowing={isShowingEnded}
                        listId={endedListId}
                        onToggle={() => setShowingEnded((value) => !value)}
                    />
                )}
            </div>
            {ended.length > 0 && (
                <div className="px-1 pb-1.5">
                    <EndedTasksList
                        expanded={isShowingEnded}
                        listId={endedListId}
                        tasks={ended}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                </div>
            )}
        </section>
    );
}

/**
 * Background work as a collapsible list in the composer strip (`agentChatBackgroundWork`): failures from the latest
 * turn first so one is never buried, then each running subagent and background shell with its elapsed time, opened in
 * its side tab on click where the host can open one and stoppable on its own or, with two or more running, all at once
 * from the header. The header names the section and counts what runs, the way the Plan section counts its steps, and
 * folded it names the latest task to start. Ended work waits behind an `Ended N` button in the header. Failures stay
 * until the user dismisses them, which files them under the ended tasks; the section leaves once nothing runs and no
 * failure waits. A single running task with no failure drops the header (`SoleTaskSection`).
 */
export function AgentChatBackgroundWorkSection({
    terminalId,
    work,
    onOpenTask,
}: {
    terminalId: string;
    work: AgentChatBackgroundWork;
    /**
     * Opens a task's tab beside the Chat; absent where the host cannot, which leaves each task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const soleTask = agentChatBackgroundWorkSoleTask(work);
    if (soleTask) {
        return (
            <SoleTaskSection
                ended={work.ended}
                task={soleTask}
                terminalId={terminalId}
                onOpenTask={onOpenTask}
            />
        );
    }
    return <FoldableSection terminalId={terminalId} work={work} onOpenTask={onOpenTask} />;
}

/**
 * Background work under a header that folds it, for several running tasks or a failure to report. Asking for the ended
 * tasks from a folded section unfolds it too, since the list they join is the section's body.
 */
function FoldableSection({
    terminalId,
    work,
    onOpenTask,
}: {
    terminalId: string;
    work: AgentChatBackgroundWork;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { running, failed, ended } = work;
    const counts = agentChatBackgroundWorkCounts(work, t);
    const stoppableIds = running.filter(canStopAgentChatTask).map(({ id }) => id);
    const foldedTask = agentChatBackgroundWorkFoldedTask(work);
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, 'tasks');
    return (
        <AgentChatStripSection
            actions={
                <>
                    {ended.length > 0 && (
                        <EndedTasksToggle
                            count={ended.length}
                            isShowing={isShowingEnded && !isCollapsed}
                            listId={endedListId}
                            onToggle={() => {
                                if (isCollapsed) {
                                    toggleAgentChatStripFold(terminalId, 'tasks');
                                    setShowingEnded(true);
                                } else {
                                    setShowingEnded((value) => !value);
                                }
                            }}
                        />
                    )}
                    {stoppableIds.length >= 2 && (
                        <StopAllTasksButton taskIds={stoppableIds} terminalId={terminalId} />
                    )}
                    {failed.length > 0 && (
                        <Tooltip content={t('agentChat.tasks.dismissFailuresDetail')}>
                            <Button
                                aria-label={t('agentChat.tasks.dismissFailures')}
                                className="size-6 shrink-0 text-muted hover:text-foreground"
                                size="icon"
                                variant="ghost"
                                onClick={() =>
                                    markAgentChatFailuresSeen(
                                        terminalId,
                                        failed.map(({ id }) => id),
                                    )
                                }
                            >
                                <X aria-hidden="true" className="size-3.5" />
                            </Button>
                        </Tooltip>
                    )}
                </>
            }
            ariaLabel={[t('agentChat.tasks.backgroundWork'), ...counts].join(', ')}
            count={running.length}
            glyph={<Layers aria-hidden="true" className="size-3.5 shrink-0" />}
            label={t('agentChat.tasks.backgroundWork')}
            meta={
                failed.length > 0 && (
                    <span className="text-danger">
                        {t('agentChat.tasks.failedCount', { count: failed.length })}
                    </span>
                )
            }
            section="tasks"
            summary={foldedTask && `· ${agentChatTaskTitle(foldedTask, t)}`}
            terminalId={terminalId}
        >
            <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
                {[...failed, ...running].map((task) => (
                    <AgentChatTaskEntry
                        key={task.id}
                        task={task}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                ))}
            </ul>
            {ended.length > 0 && (
                <EndedTasksList
                    expanded={isShowingEnded}
                    listId={endedListId}
                    tasks={ended}
                    terminalId={terminalId}
                    onOpenTask={onOpenTask}
                />
            )}
        </AgentChatStripSection>
    );
}
