import type { AgentChatTask } from '@caxri/protocol';
import {
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    formatAgentChatFinishedDuration,
    formatNoticeableDuration,
    isAgentChatTaskActive,
} from '@caxri/protocol';
import { Bot, Pause, SquareTerminal } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { useClockTick } from './hooks/use-clock-tick';

/**
 * The kind glyph a subagent or a background shell shows wherever it is listed: the glyphs of the `agent` and `command`
 * timeline rows.
 */
export function AgentChatTaskGlyph({
    className,
    kind,
}: {
    className?: string;
    kind: AgentChatTask['kind'];
}) {
    const Icon = kind === 'shell' ? SquareTerminal : Bot;
    return <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', className)} />;
}

/**
 * Provider-paused work stays visibly distinct from running work without adding a timeline item status.
 */
export function AgentChatTaskStatus({ status }: { status: AgentChatTask['status'] }) {
    const { t } = useTranslation();
    return status === 'waiting' ? (
        <span className="inline-flex items-center gap-1 text-muted">
            <Pause aria-hidden="true" className="size-3.5" />
            {t('agentChat.tasks.waiting')}
        </span>
    ) : (
        <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(status)} />
    );
}

function TickingElapsed({ task }: { task: AgentChatTask }) {
    const { t } = useTranslation();
    const label = formatNoticeableDuration(agentChatTaskElapsedMs(task, useClockTick('second')), t);
    return label ? <span className="shrink-0 tabular-nums">{label}</span> : null;
}

/**
 * How long a task has run. Only a running task subscribes to the second tick, so a list of ended tasks never re-renders
 * on a clock.
 */
export function AgentChatTaskElapsed({ task }: { task: AgentChatTask }) {
    const { t } = useTranslation();
    if (isAgentChatTaskActive(task.status)) return <TickingElapsed task={task} />;
    const label = formatAgentChatFinishedDuration(
        agentChatTaskElapsedMs(task, task.endedAt ?? 0),
        agentChatTaskGlyphStatus(task.status),
        t,
    );
    return label ? <span className="shrink-0 tabular-nums">{label}</span> : null;
}
