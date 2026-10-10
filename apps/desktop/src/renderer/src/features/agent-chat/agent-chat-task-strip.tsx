import type { AgentChatTask } from '@caxri/protocol';
import { Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { stopAgentChatTask } from './agent-chat-commands';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { openAgentChatTaskTab } from './agent-chat-task-opener';
import {
    agentChatTaskStrip,
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
                    <Spinner className="size-3.5" role="presentation" />
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
 * Background work still running, just above the composer: each subagent and background shell with its elapsed time,
 * opened in its side tab on click and stoppable on its own. Stopping the turn with Esc never stops these. Hidden while
 * nothing runs; ended work stays reachable from its timeline row, so the strip only counts it.
 */
export function AgentChatTaskStrip({
    tasks,
    terminalId,
}: {
    tasks: readonly AgentChatTask[] | undefined;
    terminalId: string;
}) {
    const { running, endedCount } = agentChatTaskStrip(tasks);
    if (running.length === 0) return null;
    return (
        <section
            aria-label="Background work"
            className="rounded-md border border-border bg-surface p-1"
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 px-2 text-[11px] font-normal text-muted">
                <span className="min-w-0 flex-1 truncate">Background work</span>
                <span className="shrink-0 tabular-nums">
                    {running.length} running
                    {endedCount > 0 && ` · ${endedCount} ended`}
                </span>
            </h3>
            <ul className="m-0 flex max-h-32 list-none flex-col overflow-y-auto p-0">
                {running.map((task) => (
                    <TaskEntry key={task.id} task={task} terminalId={terminalId} />
                ))}
            </ul>
        </section>
    );
}
