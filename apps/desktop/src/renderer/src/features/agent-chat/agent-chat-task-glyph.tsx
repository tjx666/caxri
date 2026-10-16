import type { AgentChatTask } from '@caxri/protocol';
import {
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    formatAgentChatFinishedDuration,
    formatNoticeableDuration,
} from '@caxri/protocol';
import { Bot, SquareTerminal } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
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
    if (task.status === 'running') return <TickingElapsed task={task} />;
    const label = formatAgentChatFinishedDuration(
        agentChatTaskElapsedMs(task, task.endedAt ?? 0),
        agentChatTaskGlyphStatus(task.status),
        t,
    );
    return label ? <span className="shrink-0 tabular-nums">{label}</span> : null;
}
