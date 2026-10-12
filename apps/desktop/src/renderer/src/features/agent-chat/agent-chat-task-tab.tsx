import { useCallback, useMemo, useState } from 'react';

import type { AgentChatItem, AgentChatTask, AgentTaskTab } from '@caxri/protocol';
import { ArrowLeft, RotateCcw, Square } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { openTerminalFileTarget } from '../terminal/terminal-file-link-open';
import { parseTerminalFileLocation } from '../terminal/terminal-file-location';
import { terminalPaneHost } from '../terminal/terminal-pane-host';
import { stopAgentChatTask } from './agent-chat-commands';
import { AgentChatExpansionState } from './agent-chat-expansion';
import { AgentChatJumpToLatest } from './agent-chat-jump-to-latest';
import { announceAgentChatSelectionCopy } from './agent-chat-selection-copy';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { revealAgentChat } from './agent-chat-task-opener';
import { AgentChatTaskOutput } from './agent-chat-task-output';
import {
    agentChatTaskActivity,
    agentChatTaskGlyphStatus,
    agentChatTaskIdentity,
    agentChatTaskKind,
    agentChatTaskUsageSummary,
    canStopAgentChatTask,
    isAgentChatTaskTitleCommand,
} from './agent-chat-tasks';
import { buildAgentChatTimeline } from './agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import type { AgentChatExpansion } from './hooks/use-agent-chat-expansion';
import { AgentChatExpansionContext } from './hooks/use-agent-chat-expansion';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';
import { useAgentChatTask } from './hooks/use-agent-chat-task';

const STATE_CLASS_NAME =
    'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted';

/**
 * Title, identity, status, elapsed time, and Stop. Closing the tab never stops the task; only this button does.
 */
function TaskHeader({
    kind,
    task,
    terminalId,
    title,
}: {
    kind: AgentChatTask['kind'];
    task: AgentChatTask | undefined;
    terminalId: string;
    title: string;
}) {
    const { t } = useTranslation();
    const details = [
        kind === 'agent' ? agentChatTaskIdentity(task) : undefined,
        task && agentChatTaskUsageSummary(task, t),
        task && agentChatTaskActivity(task, t),
    ].filter(Boolean);
    return (
        <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-2">
            <AgentChatTaskGlyph className="mt-0.5 text-muted" kind={kind} />
            <div className="min-w-0 flex-1">
                <h2
                    className={cn(
                        'm-0 truncate text-[13px] leading-5 font-semibold text-foreground',
                        isAgentChatTaskTitleCommand(task, kind) &&
                            'font-mono text-[12px] font-normal',
                    )}
                >
                    {title}
                </h2>
                {details.length > 0 && (
                    <p className="m-0 truncate text-[11px] leading-4 text-muted">
                        {details.join(' · ')}
                    </p>
                )}
            </div>
            {task && (
                <div className="flex shrink-0 items-center gap-2 text-[12px] leading-5 text-muted">
                    <AgentChatTaskElapsed task={task} />
                    <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                    {canStopAgentChatTask(task) && (
                        <Button
                            className="min-h-6 gap-1 px-1.5"
                            size="sm"
                            variant="secondary"
                            onClick={() => stopAgentChatTask(terminalId, task.id)}
                        >
                            <Square className="size-2.5 fill-current" />
                            {t('agentChat.tasks.stop')}
                        </Button>
                    )}
                </div>
            )}
        </header>
    );
}

/**
 * A subagent's own conversation, read-only: the Chat timeline's message, reasoning, and tool rows without a composer,
 * following new content while the user reads the end.
 */
function TaskTimeline({
    isRunning,
    items,
    revision,
    terminalId,
    truncated,
}: {
    isRunning: boolean;
    items: readonly AgentChatItem[];
    revision: number;
    terminalId: string;
    truncated: boolean;
}) {
    const { t } = useTranslation();
    const { scrollReference, contentReference, isFollowing, onScroll, jumpToLatest, anchor } =
        useAgentChatScroll(revision);
    const timeline = useMemo(() => buildAgentChatTimeline(items, [], undefined), [items]);
    /**
     * Rows the user expanded stay open as the subagent's timeline rebuilds them, and toggling one holds it in place
     * instead of following, exactly as in the parent Chat.
     */
    const [expansionState] = useState(() => new AgentChatExpansionState());
    const expansion = useMemo<AgentChatExpansion>(
        () => ({ state: expansionState, onUserToggle: anchor }),
        [anchor, expansionState],
    );
    /**
     * A file the subagent cites resolves the way the parent Chat resolves one: against the Projects its Terminal may
     * reach.
     */
    const openFile = useCallback(
        (reference: string) => {
            const { target, location } = parseTerminalFileLocation(reference);
            // eslint-disable-next-line no-void -- the opener reports its own failures as toasts
            void openTerminalFileTarget(terminalId, target, location, {
                hasWorkbenchLinks: terminalPaneHost().hasWorkbenchLinks,
            });
        },
        [terminalId],
    );
    return (
        <div className="relative h-full min-h-0">
            <div
                className="h-full overflow-y-auto outline-none"
                ref={scrollReference}
                tabIndex={-1}
                onScroll={onScroll}
            >
                <div
                    className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 select-none"
                    ref={contentReference}
                    onCopy={announceAgentChatSelectionCopy}
                >
                    {truncated && (
                        <p className="m-0 text-center text-[11px] text-muted">
                            {t('agentChat.tasks.earlierHidden')}
                        </p>
                    )}
                    <AgentChatExpansionContext value={expansion}>
                        {timeline.map((entry) => (
                            <AgentChatTimelineEntryView
                                entry={entry}
                                key={entry.kind === 'item' ? entry.item.id : entry.id}
                                onOpenFile={openFile}
                            />
                        ))}
                    </AgentChatExpansionContext>
                    {timeline.length === 0 && (
                        <p className="m-0 py-8 text-center text-[13px] text-muted">
                            {t(
                                isRunning
                                    ? 'agentChat.tasks.emptyRunning'
                                    : 'agentChat.tasks.empty',
                            )}
                        </p>
                    )}
                </div>
            </div>
            <AgentChatJumpToLatest
                focusTarget={scrollReference}
                isFollowing={isFollowing}
                onJump={jumpToLatest}
            />
        </div>
    );
}

/**
 * The `caxri-agent-task://` tab: one subagent's conversation or one background shell's output, opened beside its Chat
 * (see `openAgentChatTaskTab`). The projection lives in the shared query cache, kept current by `agentChat.taskPatch`,
 * so this view only reads it. A task that neither the live Chat nor the provider's history knows (after a restart) says
 * so and offers the way back to the Chat; it is never re-run.
 */
export function AgentChatTaskTab({ tab }: { tab: AgentTaskTab }) {
    const { t } = useTranslation();
    const { projection, task, isUnavailable } = useAgentChatTask(tab.terminalId, tab.taskId);
    const snapshot = projection.data;
    const kind = agentChatTaskKind(task, snapshot);
    const taskTitle = task?.title.trim() ?? '';
    const title =
        taskTitle === ''
            ? t(kind === 'shell' ? 'agentChat.tasks.shell' : 'agentChat.tasks.subagent')
            : taskTitle;
    const isRunning = task?.status === 'running';
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
        <div className={STATE_CLASS_NAME} role="alert">
            <p className="m-0 text-foreground">{t('agentChat.tasks.loadFailed')}</p>
            <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                    // eslint-disable-next-line no-void -- the query owns the refetch result and error state
                    void projection.refetch();
                }}
            >
                <RotateCcw className="size-3.5" />
                {t('common.retry')}
            </Button>
        </div>
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
            <TaskTimeline
                isRunning={isRunning}
                items={snapshot.items}
                revision={snapshot.revision}
                terminalId={tab.terminalId}
                truncated={snapshot.truncated}
            />
        )
    ) : (
        <LoadingSkeleton variant="document" label={t('agentChat.tasks.loading')} />
    );
    return (
        <section aria-label={title} className="flex h-full min-h-0 flex-col bg-background">
            <TaskHeader kind={kind} task={task} terminalId={tab.terminalId} title={title} />
            <div className="min-h-0 flex-1">{body}</div>
        </section>
    );
}
