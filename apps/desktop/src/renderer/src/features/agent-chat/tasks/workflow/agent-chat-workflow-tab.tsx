import { useEffect, useRef, useState } from 'react';

import type { AgentChatTask, AgentChatWorkflow, AgentUsageReadout } from '@caxri/protocol';
import {
    agentChatTaskGlyphStatus,
    agentChatWorkflowAgentKind,
    agentChatWorkflowCounts,
    agentChatWorkflowSibling,
    agentUsageCostLabel,
    canStopAgentChatTask,
} from '@caxri/protocol';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';

import { LoadingSkeleton } from '../../../../components/loading-skeleton';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { useAgentChatTask } from '../../hooks/use-agent-chat-task';
import { AgentChatStatusGlyph } from '../../tools/agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from '../agent-chat-task-glyph';
import { AgentChatTaskHeaderStopButton } from '../tab/agent-chat-task-header-stop-button';
import { AgentChatTaskLoadFailed } from '../tab/agent-chat-task-load-failed';
import { AgentChatTaskTimeline } from '../tab/agent-chat-task-timeline';
import {
    agentChatWorkflowBilled,
    agentChatWorkflowHeaderStats,
    agentChatWorkflowMemberGlyphStatus,
    agentChatWorkflowMemberType,
    agentChatWorkflowPosition,
} from './agent-chat-workflow';
import { AgentChatWorkflowMemberGlyph } from './agent-chat-workflow-member-glyph';
import { AgentChatWorkflowOverview } from './agent-chat-workflow-overview';
import { useAgentChatWorkflowUsage } from './use-agent-chat-workflow-usage';

/**
 * A running member's transcript is the only view of it (Server Core cannot patch it live), so its tab re-reads it this
 * often.
 */
const RUNNING_MEMBER_POLL_MS = 3_000;

/**
 * Stop for the whole run, with what it does on hover: members still running are interrupted, finished results stay.
 * There is no per-member stop.
 */
function StopWorkflowButton({
    task,
    terminalId,
    workflow,
}: {
    task: AgentChatTask | undefined;
    terminalId: string;
    workflow: AgentChatWorkflow;
}) {
    const { t } = useTranslation();
    if (!task || !canStopAgentChatTask(task)) return null;
    const { running } = agentChatWorkflowCounts(workflow.members);
    return (
        <AgentChatTaskHeaderStopButton
            label={t('agentChat.workflow.stop')}
            taskId={task.id}
            terminalId={terminalId}
            tooltip={t('agentChat.workflow.stopDetail', { count: running })}
        />
    );
}

/**
 * One member's conversation inside its workflow tab: back to the overview, the member's name and type, previous and
 * next member, and Stop workflow, above the same timeline a subagent tab shows.
 */
function WorkflowMemberView({
    billed,
    onBack,
    onOpen,
    task,
    taskId,
    terminalId,
    workflow,
}: {
    billed: ReadonlyMap<string, AgentUsageReadout | null>;
    onBack: () => void;
    onOpen: (taskId: string) => void;
    task: AgentChatTask | undefined;
    taskId: string;
    terminalId: string;
    workflow: AgentChatWorkflow;
}) {
    const { t } = useTranslation();
    const member = workflow.members.find((entry) => entry.taskId === taskId);
    const isRunning = member?.status === 'running';
    const { projection } = useAgentChatTask(terminalId, taskId, {
        pollMs: isRunning ? RUNNING_MEMBER_POLL_MS : undefined,
    });
    const previous = agentChatWorkflowSibling(workflow, taskId, -1);
    const next = agentChatWorkflowSibling(workflow, taskId, 1);
    const snapshot = projection.data;
    const cost = billed.get(taskId);
    const position = agentChatWorkflowPosition(workflow, taskId);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
                <Tooltip
                    content={t('agentChat.workflow.backTo', {
                        title: t('agentChat.workflow.label'),
                    })}
                >
                    <Button
                        aria-label={t('agentChat.workflow.backTo', {
                            title: t('agentChat.workflow.label'),
                        })}
                        className="size-6 p-0"
                        size="sm"
                        variant="ghost"
                        onClick={onBack}
                    >
                        <ArrowLeft className="size-3.5" />
                    </Button>
                </Tooltip>
                {member && (
                    <>
                        <AgentChatWorkflowMemberGlyph
                            className="text-muted"
                            kind={agentChatWorkflowAgentKind(member.agentType)}
                        />
                        <span className="min-w-0 truncate text-[12px] leading-5 font-medium text-foreground">
                            {member.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted">
                            {[
                                agentChatWorkflowMemberType(member, t),
                                member.model,
                                cost ? agentUsageCostLabel(cost) : undefined,
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                        <AgentChatStatusGlyph
                            status={agentChatWorkflowMemberGlyphStatus(member.status)}
                        />
                    </>
                )}
                <Tooltip content={t('agentChat.workflow.previous')}>
                    <Button
                        aria-label={t('agentChat.workflow.previous')}
                        className="size-6 p-0"
                        disabled={!previous?.taskId}
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            if (previous?.taskId) onOpen(previous.taskId);
                        }}
                    >
                        <ChevronUp className="size-3.5" />
                    </Button>
                </Tooltip>
                {position && (
                    <span className="text-[11px] leading-4 text-muted tabular-nums">
                        {t('agentChat.workflow.position', position)}
                    </span>
                )}
                <Tooltip content={t('agentChat.workflow.next')}>
                    <Button
                        aria-label={t('agentChat.workflow.next')}
                        className="size-6 p-0"
                        disabled={!next?.taskId}
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            if (next?.taskId) onOpen(next.taskId);
                        }}
                    >
                        <ChevronDown className="size-3.5" />
                    </Button>
                </Tooltip>
                <StopWorkflowButton task={task} terminalId={terminalId} workflow={workflow} />
            </div>
            <div className="min-h-0 flex-1">
                {snapshot ? (
                    <AgentChatTaskTimeline
                        isRunning={isRunning}
                        items={snapshot.items}
                        revision={snapshot.revision}
                        taskId={taskId}
                        terminalId={terminalId}
                        truncated={snapshot.truncated}
                    />
                ) : projection.isError ? (
                    <AgentChatTaskLoadFailed
                        onRetry={() => {
                            void projection.refetch();
                        }}
                    />
                ) : (
                    <LoadingSkeleton variant="document" label={t('agentChat.tasks.loading')} />
                )}
            </div>
        </div>
    );
}

/**
 * The `caxri-agent-task://` tab of a workflow run. The tab label already names the run, so the header carries only the
 * numbers (members done, failed, interrupted, cost, tokens; tokens drop first when narrow, the tooltip keeps all of
 * them), its elapsed time, status, and Stop workflow. The body is the overview, or one member's conversation in the
 * same tab; going back returns focus to that member's row, and the overview stays mounted so its scroll and toggles
 * survive the round trip.
 */
export function AgentChatWorkflowTab({
    name,
    task,
    terminalId,
    workflow,
}: {
    name: string;
    task: AgentChatTask | undefined;
    terminalId: string;
    workflow: AgentChatWorkflow;
}) {
    const { t } = useTranslation();
    const [openTaskId, setOpenTaskId] = useState<string | undefined>(undefined);
    const returnFocusTo = useRef<string | undefined>(undefined);
    const overview = useRef<HTMLDivElement>(null);
    const isRunning = task?.status === 'running';
    const usage = useAgentChatWorkflowUsage(terminalId, workflow);
    const billed = agentChatWorkflowBilled(usage.values());
    const full = agentChatWorkflowHeaderStats(workflow, billed, t, { compact: false });
    const compact = agentChatWorkflowHeaderStats(workflow, billed, t, { compact: true });
    useEffect(() => {
        const id = returnFocusTo.current;
        if (openTaskId !== undefined || !id) return;
        returnFocusTo.current = undefined;
        overview.current
            ?.querySelector<HTMLElement>(`[data-workflow-member="${CSS.escape(id)}"]`)
            ?.focus();
    }, [openTaskId]);
    return (
        <>
            <header className="@container flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                <AgentChatTaskGlyph className="text-muted" isWorkflow kind="agent" />
                <Tooltip content={full}>
                    <p className="m-0 min-w-0 flex-1 truncate text-[12px] leading-5 text-muted tabular-nums">
                        <span className="hidden @md:inline">{full}</span>
                        <span className="@md:hidden">{compact}</span>
                    </p>
                </Tooltip>
                {task && (
                    <div className="flex shrink-0 items-center gap-2 text-[12px] leading-5 text-muted">
                        <AgentChatTaskElapsed task={task} />
                        <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                        <StopWorkflowButton
                            task={task}
                            terminalId={terminalId}
                            workflow={workflow}
                        />
                    </div>
                )}
            </header>
            <div className="relative min-h-0 flex-1">
                <div ref={overview} className="h-full" hidden={openTaskId !== undefined}>
                    <AgentChatWorkflowOverview
                        billed={usage}
                        isRunning={isRunning}
                        name={name}
                        terminalId={terminalId}
                        workflow={workflow}
                        onOpen={setOpenTaskId}
                    />
                </div>
                {openTaskId !== undefined && (
                    <WorkflowMemberView
                        billed={usage}
                        task={task}
                        taskId={openTaskId}
                        terminalId={terminalId}
                        workflow={workflow}
                        onBack={() => {
                            returnFocusTo.current = openTaskId;
                            setOpenTaskId(undefined);
                        }}
                        onOpen={setOpenTaskId}
                    />
                )}
            </div>
        </>
    );
}
