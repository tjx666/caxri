import { useId, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { History, X } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from './agent-chat-strip-folds';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatBackgroundWork, AgentChatRunningKind } from './agent-chat-strip-sections';
import {
    agentChatBackgroundWorkCounts,
    agentChatBackgroundWorkSoleTask,
} from './agent-chat-strip-sections';

/**
 * One glyph per running task kind (subagents, then background shells), each with its count when several kinds run, so a
 * shell running beside a subagent is never hidden behind the first task's glyph.
 */
function RunningKindGlyphs({ kinds }: { kinds: readonly AgentChatRunningKind[] }) {
    if (kinds.length === 0) return <AgentChatTaskGlyph kind="agent" />;
    return (
        <span className="inline-flex shrink-0 items-center gap-1.5">
            {kinds.map(({ kind, count }) => (
                <span className="inline-flex items-center gap-0.5" data-task-kind={kind} key={kind}>
                    <AgentChatTaskGlyph kind={kind} />
                    {kinds.length > 1 && count}
                </span>
            ))}
        </span>
    );
}

/**
 * The `N ended` disclosure: a history glyph with the count, so ended work costs no row of its own until the user asks
 * for it.
 */
function EndedTasksToggle({
    count,
    isShowing,
    listId,
    onToggle,
}: {
    count: number;
    /**
     * Whether the ended list is visible now, which a folded section rules out whatever the user last chose.
     */
    isShowing: boolean;
    listId: string;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const label = t('agentChat.tasks.endedCount', { count });
    return (
        <Tooltip content={label}>
            <Button
                aria-controls={listId}
                aria-expanded={isShowing}
                aria-label={label}
                className={cn(
                    'h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted tabular-nums hover:text-foreground',
                    isShowing && 'text-foreground',
                )}
                size="sm"
                variant="ghost"
                onClick={onToggle}
            >
                <History aria-hidden="true" className="size-3.5" />
                {count}
            </Button>
        </Tooltip>
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
 * its side tab on click where the host can open one and stoppable on its own. Ended work is counted by a header control
 * that reveals it. Failures stay until the user dismisses them, which files them under the ended tasks; the section
 * leaves once nothing runs and no failure waits. A single running task with no failure drops the header
 * (`SoleTaskSection`).
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
 * Background work under a header that folds it, for several running tasks or a failure to report.
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
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, 'tasks');
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
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
                                // The list lives in the section body, so opening it from a folded header unfolds it.
                                if (isCollapsed) {
                                    toggleAgentChatStripFold(terminalId, 'tasks');
                                    setShowingEnded(true);
                                    return;
                                }
                                setShowingEnded((value) => !value);
                            }}
                        />
                    )}
                    {failed.length > 0 && (
                        <Tooltip content={t('agentChat.tasks.dismissFailures')}>
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
            glyph={<RunningKindGlyphs kinds={work.runningKinds} />}
            label={t('agentChat.tasks.backgroundWork')}
            meta={
                <>
                    {running.length > 0 && counts[0]}
                    {failed.length > 0 && (
                        <span className="text-danger">
                            {running.length > 0 && ' · '}
                            {counts.at(-1)}
                        </span>
                    )}
                </>
            }
            section="tasks"
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
