import { useState } from 'react';

import type {
    AgentChatWorkflow,
    AgentChatWorkflowPhaseGroup,
    AgentUsageReadout,
} from '@caxri/protocol';
import { agentChatWorkflowPhaseGroups } from '@caxri/protocol';
import { ChevronDown, ChevronRight, Copy, MessageSquarePlus } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatStatusGlyph } from '../../tools/agent-chat-status-glyph';
import { agentChatWorkflowPhaseState, agentChatWorkflowPhaseSummary } from './agent-chat-workflow';
import { copyAgentChatWorkflowError, resumeAgentChatWorkflow } from './agent-chat-workflow-actions';
import { AgentChatWorkflowMemberRow } from './agent-chat-workflow-member-row';

/**
 * How the run ended, pinned above its phases: the script's result, the error it threw (copyable), or that the run was
 * interrupted with the way to ask the Agent to resume it. A running run shows nothing here.
 */
function WorkflowOutcome({
    isRunning,
    name,
    terminalId,
    workflow,
}: {
    isRunning: boolean;
    name: string;
    terminalId: string;
    workflow: AgentChatWorkflow;
}) {
    const { t } = useTranslation();
    if (isRunning) return null;
    if (workflow.isInterrupted)
        return (
            <div className="flex items-center gap-3 rounded border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] leading-5">
                <span className="min-w-0 flex-1 text-foreground">
                    {t('agentChat.workflow.interrupted')}
                </span>
                <Tooltip content={t('agentChat.workflow.resumeHint')}>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => resumeAgentChatWorkflow(terminalId, name, workflow.runId)}
                    >
                        <MessageSquarePlus className="size-3.5" />
                        {t('agentChat.workflow.resume')}
                    </Button>
                </Tooltip>
            </div>
        );
    if (workflow.error) {
        const { error } = workflow;
        return (
            <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2" role="alert">
                <div className="flex items-center gap-2 text-[12px] leading-5 font-medium text-danger">
                    <span className="min-w-0 flex-1">{t('agentChat.workflow.scriptError')}</span>
                    <Tooltip content={t('agentChat.workflow.copyError')}>
                        <Button
                            aria-label={t('agentChat.workflow.copyError')}
                            className="size-6 p-0"
                            size="sm"
                            variant="ghost"
                            onClick={() => copyAgentChatWorkflowError(error)}
                        >
                            <Copy className="size-3.5" />
                        </Button>
                    </Tooltip>
                </div>
                <pre className="m-0 max-h-40 overflow-auto font-mono text-[11px] leading-4 whitespace-pre-wrap text-foreground select-text">
                    {error}
                </pre>
            </div>
        );
    }
    if (!workflow.result) return null;
    const isStructured = /^\s*[[{]/u.test(workflow.result);
    return (
        <section
            aria-label={t('agentChat.workflow.result')}
            className="rounded border border-border px-3 py-2"
        >
            <h3 className="m-0 text-[11px] leading-4 font-medium text-muted">
                {t('agentChat.workflow.result')}
            </h3>
            <p
                className={cn(
                    'm-0 mt-1 max-h-60 overflow-auto text-[12px] leading-5 whitespace-pre-wrap text-foreground select-text',
                    isStructured && 'font-mono text-[11px] leading-4',
                )}
            >
                {workflow.result}
            </p>
        </section>
    );
}

/**
 * One phase: a header that opens and closes its members (a focusable button, so Enter and Space work), then its member
 * rows. A phase opens on its own while it runs or after a member failed, and closes once it ended normally; the user's
 * toggle wins from then on. A phase no member started only says so.
 */
function WorkflowPhase({
    billed,
    group,
    onOpen,
}: {
    billed: ReadonlyMap<string, AgentUsageReadout | null>;
    group: AgentChatWorkflowPhaseGroup;
    onOpen: (taskId: string) => void;
}) {
    const { t } = useTranslation();
    const state = agentChatWorkflowPhaseState(group.counts);
    const [toggled, setToggled] = useState<boolean | undefined>(undefined);
    const isExpanded = toggled ?? (state === 'running' || state === 'failed');
    const title = group.title ?? t('agentChat.workflow.label');
    if (state === 'notStarted')
        return (
            <li className="flex items-center gap-2 px-2 py-1 text-[12px] leading-5 text-muted">
                <ChevronRight aria-hidden="true" className="invisible size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="text-[11px]">{t('agentChat.workflow.notStarted')}</span>
            </li>
        );
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    const isClean = state === 'ended' && group.counts.failed === 0 && group.counts.stopped === 0;
    return (
        <li>
            <button
                aria-expanded={isExpanded}
                aria-label={t(
                    isExpanded
                        ? 'agentChat.workflow.collapsePhase'
                        : 'agentChat.workflow.expandPhase',
                    {
                        title,
                    },
                )}
                className="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1 text-left text-[12px] leading-5 hover:bg-list-hover-background focus-visible:outline focus-visible:outline-accent"
                data-workflow-phase={title}
                type="button"
                onClick={() => setToggled(!isExpanded)}
            >
                <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted tabular-nums">
                    {agentChatWorkflowPhaseSummary(group, state, t).map((part) => (
                        <span key={part}>{part}</span>
                    ))}
                    {group.counts.failed > 0 && (
                        <span className="text-danger">
                            {t('agentChat.workflow.failed', { count: group.counts.failed })}
                        </span>
                    )}
                    {group.counts.stopped > 0 && (
                        <span className="text-warning">
                            {t('agentChat.workflow.stopped', { count: group.counts.stopped })}
                        </span>
                    )}
                    {isClean && <AgentChatStatusGlyph status="completed" />}
                </span>
            </button>
            {isExpanded && (
                <ul className="m-0 list-none p-0 pl-4">
                    {group.members.map((member) => (
                        <AgentChatWorkflowMemberRow
                            key={member.index}
                            billed={member.taskId ? billed.get(member.taskId) : undefined}
                            member={member}
                            onOpen={onOpen}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

/**
 * A workflow tab's overview: how the run ended, then its phases and their members. Opening a member hands its task id
 * to `onOpen`, which shows that member's conversation in the same tab.
 */
export function AgentChatWorkflowOverview({
    billed,
    isRunning,
    name,
    onOpen,
    terminalId,
    workflow,
}: {
    billed: ReadonlyMap<string, AgentUsageReadout | null>;
    isRunning: boolean;
    name: string;
    onOpen: (taskId: string) => void;
    terminalId: string;
    workflow: AgentChatWorkflow;
}) {
    const { t } = useTranslation();
    const groups = agentChatWorkflowPhaseGroups(workflow);
    return (
        <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
            <WorkflowOutcome
                isRunning={isRunning}
                name={name}
                terminalId={terminalId}
                workflow={workflow}
            />
            {groups.length === 0 ? (
                <p className="m-0 px-2 text-[12px] text-muted">
                    {t(isRunning ? 'agentChat.workflow.starting' : 'agentChat.tasks.empty')}
                </p>
            ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {groups.map((group) => (
                        <WorkflowPhase
                            key={group.title ?? ''}
                            billed={billed}
                            group={group}
                            onOpen={onOpen}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
