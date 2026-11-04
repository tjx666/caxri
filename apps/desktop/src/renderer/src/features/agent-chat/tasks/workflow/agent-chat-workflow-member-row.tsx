import type { AgentChatWorkflowMember, AgentUsageReadout } from '@caxri/protocol';
import {
    agentChatItemStatusLabel,
    agentChatTaskUsageSummary,
    agentChatWorkflowAgentKind,
    agentUsageCostLabel,
    formatNoticeableDuration,
} from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { Tooltip } from '../../../../components/ui/tooltip';
import type { Translate } from '../../../../i18n';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatStatusGlyph } from '../../tools/agent-chat-status-glyph';
import { agentChatTaskBilledUsage } from '../agent-chat-tasks';
import {
    agentChatWorkflowMemberDetail,
    agentChatWorkflowMemberGlyphStatus,
    agentChatWorkflowMemberType,
    isAgentChatWorkflowMemberQuiet,
} from './agent-chat-workflow';
import { AgentChatWorkflowMemberGlyph } from './agent-chat-workflow-member-glyph';

const COLUMN_CLASS_NAME = 'w-12 shrink-0 text-right tabular-nums';

/**
 * The parts of a running member's row that follow the clock: its elapsed time, or its activity line, which says so in
 * the warning tone once the member has been quiet for two minutes. Only this leaf re-renders each second.
 */
function RunningMemberClock({
    member,
    part,
}: {
    member: AgentChatWorkflowMember;
    part: 'detail' | 'elapsed';
}) {
    const { t } = useTranslation();
    const now = useClockTick('second');
    if (part === 'elapsed')
        return member.startedAt === undefined
            ? null
            : formatNoticeableDuration(Math.max(0, now - member.startedAt), t);
    if (isAgentChatWorkflowMemberQuiet(member, now)) {
        const since = member.lastProgressAt ?? member.startedAt ?? now;
        return (
            <span className="text-warning">
                {t('agentChat.workflow.quiet', {
                    duration: formatNoticeableDuration(now - since, t) ?? '',
                })}
            </span>
        );
    }
    return agentChatWorkflowMemberDetail(member, t) ?? null;
}

/**
 * The member's status in words, for the row's accessible name; a queued member reads as waiting like its visible cell.
 */
function memberStatusLabel(member: AgentChatWorkflowMember, t: Translate): string {
    if (member.status === 'queued') return t('agentChat.workflow.waiting');
    return agentChatItemStatusLabel(agentChatWorkflowMemberGlyphStatus(member.status), t);
}

/**
 * One member of a workflow: its agent-kind glyph and label, its cost and elapsed time in fixed columns, its status, and
 * a second line saying one thing (what it is doing, its result, or its error). A queued member is dimmed and cannot be
 * opened yet; the whole row's tooltip carries its type, model, tokens, tool uses, and the opening of its task.
 */
export function AgentChatWorkflowMemberRow({
    billed,
    member,
    onOpen,
}: {
    billed: AgentUsageReadout | null | undefined;
    member: AgentChatWorkflowMember;
    onOpen: (taskId: string) => void;
}) {
    const { t } = useTranslation();
    const isQueued = member.status === 'queued';
    const isRunning = member.status === 'running';
    const taskId = isQueued ? undefined : member.taskId;
    const summary = [
        agentChatWorkflowMemberType(member, t),
        member.model,
        agentChatTaskUsageSummary(
            { usage: { totalTokens: member.usage?.totalTokens, toolUses: member.usage?.toolUses } },
            t,
            agentChatTaskBilledUsage(billed),
        ),
    ]
        .filter(Boolean)
        .join(' · ');
    const statusLabel = memberStatusLabel(member, t);
    const detail = isRunning ? undefined : agentChatWorkflowMemberDetail(member, t);
    const body = (
        <>
            <AgentChatWorkflowMemberGlyph
                className={cn('mt-0.5', isQueued ? 'text-muted/60' : 'text-muted')}
                kind={agentChatWorkflowAgentKind(member.agentType)}
            />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                    <span
                        className={cn(
                            'min-w-0 flex-1 truncate',
                            isQueued ? 'text-muted' : 'text-foreground',
                        )}
                    >
                        {member.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                        <span className={COLUMN_CLASS_NAME}>
                            {billed ? agentUsageCostLabel(billed) : undefined}
                        </span>
                        <span className={COLUMN_CLASS_NAME}>
                            {isRunning ? (
                                <RunningMemberClock member={member} part="elapsed" />
                            ) : (
                                formatNoticeableDuration(member.usage?.durationMs, t)
                            )}
                        </span>
                        <span className="flex w-14 shrink-0 justify-end">
                            {isQueued ? (
                                t('agentChat.workflow.waiting')
                            ) : (
                                <AgentChatStatusGlyph
                                    status={agentChatWorkflowMemberGlyphStatus(member.status)}
                                />
                            )}
                        </span>
                        <ChevronRight
                            aria-hidden="true"
                            className={cn('size-3.5 shrink-0', !taskId && 'invisible')}
                        />
                    </span>
                </span>
                {(detail !== undefined || isRunning) && (
                    <span
                        className={cn(
                            'min-h-4 truncate text-[11px] leading-4',
                            member.status === 'failed' ? 'text-danger' : 'text-muted',
                        )}
                    >
                        {isRunning ? <RunningMemberClock member={member} part="detail" /> : detail}
                    </span>
                )}
            </span>
        </>
    );
    const className =
        'flex w-full min-w-0 items-start gap-2 rounded border-0 bg-transparent px-2 py-1 text-left text-[12px] leading-5';
    return (
        <li>
            <Tooltip
                content={
                    <span className="whitespace-pre-wrap">
                        {member.promptPreview ? `${summary}\n\n${member.promptPreview}` : summary}
                    </span>
                }
            >
                {taskId ? (
                    <button
                        aria-label={t('agentChat.workflow.openWithStatus', {
                            title: member.label,
                            status: statusLabel,
                        })}
                        className={cn(
                            className,
                            'cursor-pointer hover:bg-list-hover-background focus-visible:outline focus-visible:outline-accent',
                        )}
                        data-workflow-member={taskId}
                        type="button"
                        onClick={() => onOpen(taskId)}
                    >
                        {body}
                    </button>
                ) : (
                    // Not openable yet, but still a focusable trigger so its tooltip reaches keyboard users.
                    <button aria-disabled="true" className={className} type="button">
                        {body}
                    </button>
                )}
            </Tooltip>
        </li>
    );
}
