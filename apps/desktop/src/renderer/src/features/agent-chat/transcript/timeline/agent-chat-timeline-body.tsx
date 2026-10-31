import type { ComponentProps } from 'react';
import { Fragment } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatEditContext } from '../../hooks/use-agent-chat-edit';
import {
    AgentChatMcpServersContext,
    useAgentChatMcpServers,
} from '../../hooks/use-agent-chat-mcp-server';
import { AgentChatReadBackHistoryContext } from '../../hooks/use-agent-chat-read-back-history';
import { useAgentChatSkillHost } from '../../hooks/use-agent-chat-skill-host';
import { AgentChatSkillsContext } from '../../hooks/use-agent-chat-skills';
import { AgentChatTerminalContext } from '../../hooks/use-agent-chat-terminal';
import { AgentChatDayBreak } from '../../messages/agent-chat-message-time';
import { AgentChatReplyPlaceholder } from '../../messages/agent-chat-reply-placeholder';
import {
    AgentChatReferencesContext,
    useAgentChatReferenceIndex,
} from '../../references/use-agent-chat-references';
import { AgentChatEarlierVersionNotice } from '../../versions/agent-chat-earlier-version-notice';
import type { AgentChatVersionView } from '../../versions/use-agent-chat-versions';
import { AgentChatVersionsContext } from '../../versions/use-agent-chat-versions';
import { AgentChatPendingTimeline } from '../agent-chat-pending-timeline';
import { AgentChatSettledTimeline } from '../agent-chat-settled-timeline';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    AGENT_CHAT_TURN_START_ATTRIBUTE,
    agentChatTimelineEntryKey,
    agentChatTurnStartId,
} from '../agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';

/**
 * The live timeline's rows, each preceded by the day break that starts its calendar day. A row that opens a turn sits
 * in a box marked with the turn's id (`AGENT_CHAT_TURN_START_ATTRIBUTE`), laid out like a settled entry's box, so the
 * return hint can jump to a turn no prompt opened.
 */
function LiveTimelineEntries({
    dayBreaks,
    mountedFrom,
    onOpenFile,
    timeline,
}: {
    dayBreaks: ReadonlyMap<string, number>;
    mountedFrom: number;
    onOpenFile: (reference: string) => void;
    timeline: readonly AgentChatTimelineEntry[];
}) {
    return timeline.slice(mountedFrom).map((entry, offset) => {
        const index = mountedFrom + offset;
        const key = agentChatTimelineEntryKey(entry);
        const dayBreak = dayBreaks.get(key);
        const turnStartId = agentChatTurnStartId(entry, timeline[index - 1]);
        const view = <AgentChatTimelineEntryView entry={entry} onOpenFile={onOpenFile} />;
        return (
            <Fragment key={key}>
                {dayBreak !== undefined && <AgentChatDayBreak timestamp={dayBreak} />}
                {turnStartId === undefined ? (
                    view
                ) : (
                    <div
                        {...{ [AGENT_CHAT_TURN_START_ATTRIBUTE]: turnStartId }}
                        className="flex flex-col gap-3"
                    >
                        {view}
                    </div>
                )}
            </Fragment>
        );
    });
}

/**
 * The Chat's settled, live, and pending timelines under the contexts their rows read.
 */
export function AgentChatTimelineBody({
    dayBreaks,
    isAwaitingReply,
    mcpServers,
    mountedFrom,
    onOpenFile,
    pending,
    readBackHistory,
    settledChunks,
    terminalId,
    timeline,
    versionView,
}: {
    dayBreaks: ReadonlyMap<string, number>;
    isAwaitingReply: boolean;
    mcpServers: AgentChatSnapshot['mcpServers'];
    /**
     * Index of the first live entry to mount; earlier ones are added by the idle backfill.
     */
    mountedFrom: number;
    onOpenFile: (reference: string) => void;
    pending: ComponentProps<typeof AgentChatPendingTimeline>['pending'];
    readBackHistory: ComponentProps<typeof AgentChatReadBackHistoryContext>['value'];
    settledChunks: ComponentProps<typeof AgentChatSettledTimeline>['chunks'];
    terminalId: string;
    timeline: readonly AgentChatTimelineEntry[];
    /**
     * The earlier versions on screen: their actions, the turn running in the version shown, and the notice that an
     * earlier one is.
     */
    versionView: AgentChatVersionView;
}) {
    const { editActions, isViewingEarlier, snapshot, versions } = versionView;
    const servers = useAgentChatMcpServers(mcpServers);
    const skills = useAgentChatSkillHost(terminalId);
    const references = useAgentChatReferenceIndex(settledChunks, timeline);
    return (
        <AgentChatMcpServersContext value={servers}>
            <AgentChatTerminalContext value={terminalId}>
                <AgentChatSkillsContext value={skills}>
                    <AgentChatReferencesContext value={references}>
                        {/*
                         * History read back is not in the projection, so it never offers Edit, Fork, or Restore; keeping it
                         * outside the actions, which change with every patch, lets a patch skip it. Its menus list Edit and
                         * Fork disabled with why.
                         */}
                        <AgentChatReadBackHistoryContext value={readBackHistory}>
                            <AgentChatSettledTimeline
                                chunks={settledChunks}
                                onOpenFile={onOpenFile}
                            />
                        </AgentChatReadBackHistoryContext>
                        <AgentChatEditContext value={editActions}>
                            <AgentChatVersionsContext value={versions}>
                                <LiveTimelineEntries
                                    dayBreaks={dayBreaks}
                                    mountedFrom={mountedFrom}
                                    timeline={timeline}
                                    onOpenFile={onOpenFile}
                                />
                            </AgentChatVersionsContext>
                            {isAwaitingReply && !isViewingEarlier && (
                                <AgentChatReplyPlaceholder turnId={snapshot?.activeTurnId} />
                            )}
                            <AgentChatPendingTimeline pending={pending} onOpenFile={onOpenFile} />
                        </AgentChatEditContext>
                        {isViewingEarlier && (
                            <AgentChatEarlierVersionNotice
                                onShowCurrent={versionView.showCurrent}
                            />
                        )}
                    </AgentChatReferencesContext>
                </AgentChatSkillsContext>
            </AgentChatTerminalContext>
        </AgentChatMcpServersContext>
    );
}
