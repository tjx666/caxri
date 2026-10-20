import { useMemo, useState } from 'react';

import type { AgentChatItem, AgentChatTask, AgentTaskTab } from '@caxri/protocol';
import {
    agentChatTaskActivity,
    agentChatTaskGlyphStatus,
    agentChatTaskIdentity,
    agentChatTaskUsageSummary,
    canStopAgentChatTask,
    isAgentChatTaskTitleCommand,
} from '@caxri/protocol';
import { ArrowLeft, RotateCcw, Square } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    agentChatTaskKey,
    stopAgentChatTask,
    useAgentChatTaskStopStore,
} from './agent-chat-commands';
import { AgentChatExpansionState } from './agent-chat-expansion';
import { AgentChatHistoryHead } from './agent-chat-history-head';
import { AgentChatJumpToLatest } from './agent-chat-jump-to-latest';
import { AgentChatSelectionToolbar } from './agent-chat-selection-toolbar';
import { agentChatSettledChunks } from './agent-chat-settled-chunks';
import { AgentChatSettledTimeline } from './agent-chat-settled-timeline';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed, AgentChatTaskGlyph } from './agent-chat-task-glyph';
import { revealAgentChat } from './agent-chat-task-opener';
import { AgentChatTaskOutput } from './agent-chat-task-output';
import { agentChatTaskBilledUsage, agentChatTaskKind } from './agent-chat-tasks';
import { buildAgentChatTimeline } from './agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import type { AgentChatExpansion } from './hooks/use-agent-chat-expansion';
import { AgentChatExpansionContext } from './hooks/use-agent-chat-expansion';
import { useAgentChatHistory } from './hooks/use-agent-chat-history';
import { useAgentChatOpenFile } from './hooks/use-agent-chat-open-file';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';
import { useAgentChatTask } from './hooks/use-agent-chat-task';
import { useLoadingStyle } from './loading';

/**
 * An ended subagent's transcript can still gain its last response after the task reports it ended, so its usage is
 * re-read rarely rather than never.
 */
const ENDED_TASK_USAGE_POLL_MS = 30_000;

const STATE_CLASS_NAME =
    'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted';

/**
 * The header's Stop, busy from the click until the task leaves `running`, like the composer strip's.
 */
function TaskStopButton({ taskId, terminalId }: { taskId: string; terminalId: string }) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        stopping.has(agentChatTaskKey(terminalId, taskId)),
    );
    const label = t(isStopping ? 'agentChat.tasks.stopping' : 'agentChat.tasks.stop');
    return (
        <Tooltip content={label}>
            <Button
                aria-busy={isStopping || undefined}
                aria-disabled={isStopping || undefined}
                className="min-h-6 gap-1 px-1.5 aria-busy:cursor-progress aria-busy:opacity-100"
                size="sm"
                variant="secondary"
                onClick={() => {
                    if (!isStopping) stopAgentChatTask(terminalId, taskId);
                }}
            >
                {isStopping ? (
                    <Spinner className="size-3.5" role="presentation" />
                ) : (
                    <Square aria-hidden="true" className="size-2.5 fill-current" />
                )}
                {label}
            </Button>
        </Tooltip>
    );
}

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
                        <TaskStopButton taskId={task.id} terminalId={terminalId} />
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
    taskId,
    terminalId,
    truncated,
}: {
    isRunning: boolean;
    items: readonly AgentChatItem[];
    revision: number;
    taskId: string;
    terminalId: string;
    truncated: boolean;
}) {
    const { t } = useTranslation();
    const {
        scrollReference,
        contentReference,
        isLatestInView,
        onScroll,
        jumpToLatest,
        stopFollowing,
        anchor,
    } = useAgentChatScroll(revision);
    /**
     * Older items the projection's budget cut are paged back from Server Core like the Chat's own history: a page goes
     * in above the reader's position and renders as settled chunks apart from the live, streaming items.
     */
    const history = useAgentChatHistory(
        terminalId,
        { historyId: taskId, truncated },
        { scrollReference, contentReference, stopFollowing },
        taskId,
    );
    const olderItems = history.history.items;
    const settledChunks = useMemo(() => agentChatSettledChunks(olderItems, []), [olderItems]);
    const timeline = useMemo(() => buildAgentChatTimeline(items, [], undefined), [items]);
    /**
     * Older items exist that no page will bring back: the provider's record was cut off. Reaching the real start shows
     * nothing.
     */
    const isEarlierHidden =
        !history.hasMore && (history.history.isLoaded ? history.history.truncated : truncated);
    /**
     * Rows the user expanded stay open as the subagent's timeline rebuilds them, and toggling one holds it in place
     * instead of following, exactly as in the parent Chat.
     */
    const [expansionState] = useState(() => new AgentChatExpansionState());
    const expansion = useMemo<AgentChatExpansion>(
        () => ({ state: expansionState, onUserToggle: anchor }),
        [anchor, expansionState],
    );
    const openFile = useAgentChatOpenFile(terminalId);
    return (
        <div className="relative h-full min-h-0">
            <div
                className={cn(
                    'absolute inset-x-0 top-0 overflow-y-auto outline-none',
                    // Ends above Jump to latest while it shows, as the Chat pane does, so it never covers a line.
                    isLatestInView ? 'bottom-0' : 'bottom-10',
                )}
                ref={scrollReference}
                tabIndex={-1}
                onScroll={onScroll}
            >
                <div
                    className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 select-none"
                    ref={contentReference}
                >
                    <AgentChatHistoryHead
                        hasFailed={history.history.status === 'failed'}
                        hasMore={history.hasMore}
                        isLoading={history.history.status === 'loading'}
                        isUnavailable={false}
                        loadedCount={olderItems.length}
                        providerName=""
                        scrollReference={scrollReference}
                        onLoad={history.loadOlder}
                        onOpenAsTerminal={undefined}
                    />
                    {isEarlierHidden && (
                        <p className="m-0 text-center text-[11px] text-muted">
                            {t('agentChat.tasks.earlierHidden')}
                        </p>
                    )}
                    <AgentChatExpansionContext value={expansion}>
                        <AgentChatSettledTimeline chunks={settledChunks} onOpenFile={openFile} />
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
            {/* A quote lands in the parent Chat's draft, so the Chat comes forward to show it. */}
            <AgentChatSelectionToolbar
                contentReference={contentReference}
                scrollReference={scrollReference}
                terminalId={terminalId}
            />
            <AgentChatJumpToLatest
                focusTarget={scrollReference}
                isLatestInView={isLatestInView}
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
            <TaskHeader kind={kind} task={task} terminalId={tab.terminalId} title={title} />
            <div className="min-h-0 flex-1">{body}</div>
        </section>
    );
}
