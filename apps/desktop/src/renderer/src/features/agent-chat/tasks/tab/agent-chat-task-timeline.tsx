import { useMemo } from 'react';

import type { AgentChatItem } from '@caxri/protocol';

import { useTranslation } from '../../../../i18n';
import {
    AgentChatExpansionContext,
    useAgentChatExpansionHost,
} from '../../hooks/use-agent-chat-expansion';
import { useAgentChatHistory } from '../../hooks/use-agent-chat-history';
import {
    AgentChatRevealFileContext,
    useAgentChatOpenFile,
    useAgentChatRevealFile,
} from '../../hooks/use-agent-chat-open-file';
import { useAgentChatScroll } from '../../hooks/use-agent-chat-scroll';
import { AgentChatSelectionToolbar } from '../../messages/agent-chat-selection-toolbar';
import { AgentChatHistoryHead } from '../../transcript/agent-chat-history-head';
import { AgentChatJumpToLatest } from '../../transcript/agent-chat-jump-to-latest';
import { agentChatSettledChunks } from '../../transcript/agent-chat-settled-chunks';
import { AgentChatSettledTimeline } from '../../transcript/agent-chat-settled-timeline';
import { buildAgentChatTimeline } from '../../transcript/agent-chat-timeline';
import { AgentChatTimelineEntryView } from '../../transcript/timeline/agent-chat-timeline-entry-view';

/**
 * A subagent's own conversation (or a workflow member's), read-only: the Chat timeline's message, reasoning, and tool
 * rows without a composer, following new content while the user reads the end.
 */
export function AgentChatTaskTimeline({
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
    // Rows the user expanded stay open and hold in place, exactly as in the parent Chat.
    const expansion = useAgentChatExpansionHost(anchor);
    const openFile = useAgentChatOpenFile(terminalId, [olderItems, items]);
    const revealFile = useAgentChatRevealFile(terminalId, [olderItems, items]);
    return (
        <div className="relative h-full min-h-0">
            <div
                className="absolute inset-0 overflow-y-auto outline-none"
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
                        <AgentChatRevealFileContext value={revealFile}>
                            <AgentChatSettledTimeline
                                chunks={settledChunks}
                                onOpenFile={openFile}
                            />
                            {timeline.map((entry) => (
                                <AgentChatTimelineEntryView
                                    entry={entry}
                                    key={entry.kind === 'item' ? entry.item.id : entry.id}
                                    onOpenFile={openFile}
                                />
                            ))}
                        </AgentChatRevealFileContext>
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
