import { useId, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { Square, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { stopAgentChatTask } from './agent-chat-commands';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { openAgentChatTaskTab } from './agent-chat-task-opener';
import {
    agentChatTaskGlyphStatus,
    agentChatTasksLatestEnd,
    agentChatTaskStripView,
    canStopAgentChatTask,
    isAgentChatTaskTitleCommand,
} from './agent-chat-tasks';

function TaskEntry({ task, terminalId }: { task: AgentChatTask; terminalId: string }) {
    const title = task.title || (task.kind === 'shell' ? 'Shell' : 'Subagent');
    return (
        <li className="group/task flex min-w-0 items-center gap-1 rounded text-[12px] leading-5 hover:bg-[var(--selection)]">
            <button
                aria-label={`Open ${title}`}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-0.5 text-left text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => openAgentChatTaskTab(terminalId, task.id)}
            >
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
            </button>
            {canStopAgentChatTask(task) && (
                <Tooltip content="Stop">
                    <Button
                        aria-label={`Stop ${title}`}
                        className="size-6 shrink-0 text-muted hover:text-foreground"
                        size="icon"
                        variant="ghost"
                        onClick={() => stopAgentChatTask(terminalId, task.id)}
                    >
                        <Square className="size-2.5 fill-current" />
                    </Button>
                </Tooltip>
            )}
        </li>
    );
}

/**
 * Background work, just above the composer: each running subagent and background shell with its elapsed time, opened in
 * its side tab on click and stoppable on its own. Stopping the turn with Esc never stops these. Ended work is counted,
 * and the count reveals it (most recent first, with how each ended) so a task that just finished is one click from its
 * tab without hunting for its timeline row. When the last task ends, the strip collapses to that count until the next
 * turn starts or the user dismisses it (see `agentChatTaskStripView`), instead of disappearing at once.
 */
export function AgentChatTaskStrip({
    latestTurnStartedAt,
    tasks,
    terminalId,
}: {
    /**
     * When the Chat's latest turn started; work that ended before it no longer keeps an idle strip open.
     */
    latestTurnStartedAt: number | undefined;
    tasks: readonly AgentChatTask[] | undefined;
    terminalId: string;
}) {
    const [dismissedAt, setDismissedAt] = useState<number | undefined>();
    const view = agentChatTaskStripView(tasks, { dismissedAt, latestTurnStartedAt });
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    if (!view) return null;
    const { running, ended, isDismissible } = view;
    return (
        <section
            aria-label="Background work"
            className="rounded-md border border-border bg-surface p-1"
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 px-2 text-[11px] font-normal text-muted">
                <span className="min-w-0 flex-1 truncate">Background work</span>
                <span className="shrink-0 tabular-nums">
                    {running.length > 0 && `${running.length} running`}
                    {running.length > 0 && ended.length > 0 && ' · '}
                    {ended.length > 0 && (
                        <button
                            aria-controls={endedListId}
                            aria-expanded={isShowingEnded}
                            className="cursor-pointer border-0 bg-transparent p-0 text-muted tabular-nums hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                            type="button"
                            onClick={() => setShowingEnded((value) => !value)}
                        >
                            {ended.length} ended
                        </button>
                    )}
                </span>
                {isDismissible && (
                    <Tooltip content="Dismiss">
                        <Button
                            aria-label="Dismiss ended background work"
                            className="-mr-1.5 size-5 shrink-0 text-muted hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                                setShowingEnded(false);
                                setDismissedAt(agentChatTasksLatestEnd(ended));
                            }}
                        >
                            <X aria-hidden="true" className="size-3" />
                        </Button>
                    </Tooltip>
                )}
            </h3>
            {running.length > 0 && (
                <ul className="m-0 flex max-h-32 list-none flex-col overflow-y-auto p-0">
                    {running.map((task) => (
                        <TaskEntry key={task.id} task={task} terminalId={terminalId} />
                    ))}
                </ul>
            )}
            {isShowingEnded && ended.length > 0 && (
                <ul
                    aria-label="Ended background work"
                    className={cn(
                        'm-0 flex max-h-32 list-none flex-col overflow-y-auto p-0',
                        running.length > 0 && 'mt-1 border-t border-border pt-1',
                    )}
                    id={endedListId}
                >
                    {ended.map((task) => (
                        <TaskEntry key={task.id} task={task} terminalId={terminalId} />
                    ))}
                </ul>
            )}
        </section>
    );
}
