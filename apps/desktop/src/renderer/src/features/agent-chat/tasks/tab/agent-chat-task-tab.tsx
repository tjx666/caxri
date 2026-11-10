import { useEffect } from 'react';

import type { AgentChatTask, AgentTaskTab } from '@caxri/protocol';
import {
    agentChatTaskActivity,
    agentChatTaskGlyphStatus,
    agentChatTaskIdentity,
    agentChatTaskUsageSummary,
    agentChatTaskWorkflow,
    canStopAgentChatTask,
} from '@caxri/protocol';
import { ArrowLeft } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { LoadingSkeleton } from '../../../../components/loading-skeleton';
import { Button } from '../../../../components/ui/button';
import { useTranslation } from '../../../../i18n';
import { useAgentChatTask } from '../../hooks/use-agent-chat-task';
import { useLoadingStyle } from '../../loading';
import { AgentChatStatusGlyph } from '../../tools/agent-chat-status-glyph';
import { AgentChatTaskElapsed } from '../agent-chat-task-glyph';
import { revealAgentChat } from '../agent-chat-task-opener';
import {
    agentChatTaskBilledUsage,
    agentChatTaskKind,
    agentChatTaskTitle,
} from '../agent-chat-tasks';
import { AgentChatWorkflowTab } from '../workflow/agent-chat-workflow-tab';
import { AgentChatTaskHeaderStopButton } from './agent-chat-task-header-stop-button';
import { AgentChatTaskLoadFailed } from './agent-chat-task-load-failed';
import { AgentChatTaskOutput } from './agent-chat-task-output';
import { AgentChatTaskTimeline } from './agent-chat-task-timeline';

/**
 * An ended subagent's transcript can still gain its last response after the task reports it ended, so its usage is
 * re-read rarely rather than never.
 */
const ENDED_TASK_USAGE_POLL_MS = 30_000;

const STATE_CLASS_NAME =
    'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted';

/**
 * Identity, usage, activity, elapsed time, status, and Stop. Closing the tab never stops the task; only this button
 * does. The title and kind icon are left to the surrounding chrome (the Side View header or the pane tab), which
 * already shows both.
 */
function TaskHeader({
    kind,
    task,
    terminalId,
}: {
    kind: AgentChatTask['kind'];
    task: AgentChatTask | undefined;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isRunning = task?.status === 'running';
    // Polled every two seconds while the subagent runs, like the status bar's usage chip.
    const { data: billed } = usePolledQuery(
        'terminal.agentTaskUsage',
        { terminalId, taskId: task?.id ?? '' },
        {
            label: 'terminal.agentTaskUsage',
            intervalMs: isRunning ? 2_000 : ENDED_TASK_USAGE_POLL_MS,
            staleTime: 1_000,
            retry: false,
            enabled: kind === 'agent' && task !== undefined,
        },
    );
    const details = [
        kind === 'agent' ? agentChatTaskIdentity(task) : undefined,
        task && agentChatTaskUsageSummary(task, t, agentChatTaskBilledUsage(billed)),
        task && agentChatTaskActivity(task, t),
    ].filter(Boolean);
    return (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            <p className="m-0 min-w-0 flex-1 truncate text-[12px] leading-5 text-muted tabular-nums">
                {details.join(' · ')}
            </p>
            {task && (
                <div className="flex shrink-0 items-center gap-2 text-[12px] leading-5 text-muted">
                    <AgentChatTaskElapsed task={task} />
                    <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                    {canStopAgentChatTask(task) && (
                        <AgentChatTaskHeaderStopButton taskId={task.id} terminalId={terminalId} />
                    )}
                </div>
            )}
        </header>
    );
}

/**
 * The `caxri-agent-task://` tab: one subagent's conversation or one background shell's output, opened beside its Chat
 * (see `openAgentChatTaskTab`). The projection lives in the shared query cache, kept current by `agentChat.taskPatch`,
 * so this view only reads it. A task that neither the live Chat nor the provider's history knows (after a restart) says
 * so and offers the way back to the Chat; it is never re-run. A workflow run gets its own overview
 * (`AgentChatWorkflowTab`), live from the Chat's task list or rebuilt from the provider's run record.
 */
export function AgentChatTaskTab({ tab }: { tab: AgentTaskTab }) {
    const { t } = useTranslation();
    const { projection, task, isUnavailable } = useAgentChatTask(tab.terminalId, tab.taskId);
    const snapshot = projection.data;
    const kind = agentChatTaskKind(task, snapshot);
    const title = agentChatTaskTitle({ kind, title: task?.title.trim() ?? '' }, t);
    const isRunning = task?.status === 'running';
    const workflow = agentChatTaskWorkflow(task, snapshot);
    const hasWorkflowEnded = task?.workflow !== undefined && task.status !== 'running';
    const { refetch } = projection;
    // A run's result is read from the record it writes as it ends, so the tab reads the run once more when it ends.
    useEffect(() => {
        if (hasWorkflowEnded) void refetch();
    }, [hasWorkflowEnded, refetch]);
    // The same sweep setting as the Chat pane: the CSS keys off this ancestor attribute.
    const { statusShimmer } = useLoadingStyle();
    const body = isUnavailable ? (
        <div className={STATE_CLASS_NAME}>
            <p className="m-0 text-foreground">{t('agentChat.tasks.unavailable')}</p>
            <p className="m-0 text-[12px]">{t('agentChat.tasks.unavailableDetail')}</p>
            <Button size="sm" variant="secondary" onClick={() => revealAgentChat(tab.terminalId)}>
                <ArrowLeft className="size-3.5" />
                {t('agentChat.review.backToChat')}
            </Button>
        </div>
    ) : projection.isError ? (
        <AgentChatTaskLoadFailed
            onRetry={() => {
                void projection.refetch();
            }}
        />
    ) : snapshot ? (
        kind === 'shell' ? (
            <AgentChatTaskOutput
                command={task?.command}
                isOutputCapped={snapshot.isOutputCapped ?? false}
                isRunning={isRunning}
                isTruncated={snapshot.truncated}
                output={snapshot.output}
                revision={snapshot.revision}
            />
        ) : (
            <AgentChatTaskTimeline
                isRunning={isRunning}
                items={snapshot.items}
                revision={snapshot.revision}
                taskId={snapshot.taskId}
                terminalId={tab.terminalId}
                truncated={snapshot.truncated}
            />
        )
    ) : (
        <LoadingSkeleton variant="document" label={t('agentChat.tasks.loading')} />
    );
    return (
        <section
            aria-label={title}
            className="flex h-full min-h-0 flex-col bg-background"
            data-agent-chat-status-shimmer={statusShimmer}
        >
            {workflow ? (
                <AgentChatWorkflowTab
                    name={title}
                    task={task}
                    terminalId={tab.terminalId}
                    workflow={workflow}
                />
            ) : (
                <>
                    <TaskHeader kind={kind} task={task} terminalId={tab.terminalId} />
                    <div className="min-h-0 flex-1">{body}</div>
                </>
            )}
        </section>
    );
}
