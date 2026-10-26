import { useId, useState } from 'react';

import { ChevronRight, X } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { agentChatChevronMotion } from '../../transcript/agent-chat-disclosure';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatBackgroundWork, AgentChatRunningKind } from './agent-chat-strip-sections';
import { agentChatBackgroundWorkCounts } from './agent-chat-strip-sections';

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
 * The tasks behind the `N ended` disclosure, most recent first, with how each ended.
 */
function EndedTasks({
    tasks,
    terminalId,
    onOpenTask,
}: {
    tasks: AgentChatBackgroundWork['ended'];
    terminalId: string;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const [isShowing, setShowing] = useState(false);
    const listId = useId();
    if (tasks.length === 0) return null;
    return (
        <>
            <button
                aria-controls={listId}
                aria-expanded={isShowing}
                className="mx-2 mt-1 inline-flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-[11px] text-muted tabular-nums hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => setShowing((value) => !value)}
            >
                {t('agentChat.tasks.endedCount', { count: tasks.length })}
                {/* The count reads as plain status text without a disclosure cue. */}
                <ChevronRight
                    aria-hidden="true"
                    className={cn(
                        'size-3 shrink-0',
                        agentChatChevronMotion(isShowing),
                        isShowing && 'rotate-90',
                    )}
                />
            </button>
            <DisclosureMotion
                animate
                expanded={isShowing}
                id={listId}
                kind="agent-chat-ended-tasks"
            >
                <ul
                    aria-label={t('agentChat.tasks.endedList')}
                    className="m-0 mt-1 flex max-h-32 list-none flex-col overflow-y-auto p-0"
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
        </>
    );
}

/**
 * Background work as a collapsible list in the composer strip (`agentChatBackgroundWork`): failures from the latest
 * turn first so one is never buried, then each running subagent and background shell with its elapsed time, opened in
 * its side tab on click where the host can open one and stoppable on its own. Stopping the turn never stops these, and
 * the list says so while a turn runs. Ended work is counted, and the count reveals it. Failures stay until the user
 * dismisses them, which files them under the ended tasks; the section leaves once nothing runs and no failure waits.
 */
export function AgentChatBackgroundWorkSection({
    isTurnRunning,
    terminalId,
    work,
    onOpenTask,
}: {
    isTurnRunning: boolean;
    terminalId: string;
    work: AgentChatBackgroundWork;
    /**
     * Opens a task's tab beside the Chat; absent where the host cannot, which leaves each task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { running, failed, ended } = work;
    const counts = agentChatBackgroundWorkCounts(work, t);
    return (
        <AgentChatStripSection
            actions={
                failed.length > 0 && (
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
                )
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
            {isTurnRunning && running.length > 0 && (
                <p className="m-0 mt-1 px-2 text-[11px] text-muted">
                    {t('agentChat.tasks.stopTurnKeepsTasks')}
                </p>
            )}
            <EndedTasks tasks={ended} terminalId={terminalId} onOpenTask={onOpenTask} />
        </AgentChatStripSection>
    );
}
