import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';

import {
    AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE,
    AGENT_CHAT_SETTLED_TIMELINE_ATTRIBUTE,
} from './agent-chat-history';
import { AgentChatDayBreak } from './agent-chat-message-time';
import type { AgentChatSettledChunk } from './agent-chat-settled-chunks';
import { agentChatDayBreaks } from './agent-chat-time';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { agentChatTimelineEntryKey } from './agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';

interface SettledChunkProperties {
    entries: readonly AgentChatTimelineEntry[];
    previousDay: number | undefined;
    onOpenFile: (target: string) => void;
}

/**
 * One chunk of the history read back. It renders again only when its own entries change, so a patch that keeps one more
 * evicted item reconciles the last chunk, not every entry read back. Each entry lets the browser skip its layout and
 * paint while it is offscreen (`content-visibility: auto`); the remembered size (`contain-intrinsic-size: auto`) keeps
 * the scroll height stable once an entry has rendered.
 */
const SettledChunk = memo(
    ({ entries, previousDay, onOpenFile }: SettledChunkProperties): ReactNode => {
        const dayBreaks = useMemo(
            () => agentChatDayBreaks(entries, previousDay),
            [entries, previousDay],
        );
        return (
            <div className="flex flex-col gap-3">
                {entries.map((entry) => {
                    const key = agentChatTimelineEntryKey(entry);
                    const dayBreak = dayBreaks.get(key);
                    return (
                        <div
                            {...{ [AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE]: '' }}
                            className="flex flex-col gap-3 [contain-intrinsic-size:auto_80px] [content-visibility:auto]"
                            key={key}
                        >
                            {dayBreak !== undefined && <AgentChatDayBreak timestamp={dayBreak} />}
                            <AgentChatTimelineEntryView entry={entry} onOpenFile={onOpenFile} />
                        </div>
                    );
                })}
            </div>
        );
    },
);

/**
 * The history read back from before the live projection. It never changes while the conversation streams, so a patch
 * skips it, and it is split into chunks so reading a page back or keeping an evicted item renders only what changed.
 */
export function AgentChatSettledTimeline({
    chunks,
    onOpenFile,
}: {
    chunks: readonly AgentChatSettledChunk[];
    onOpenFile: (target: string) => void;
}): ReactNode {
    if (chunks.length === 0) return null;
    const previousDays: Array<number | undefined> = [];
    let day: number | undefined;
    for (const chunk of chunks) {
        previousDays.push(day);
        day = chunk.lastDay ?? day;
    }
    return (
        <div {...{ [AGENT_CHAT_SETTLED_TIMELINE_ATTRIBUTE]: '' }} className="flex flex-col gap-3">
            {chunks.map((chunk, index) => (
                <SettledChunk
                    entries={chunk.entries}
                    key={chunk.key}
                    previousDay={previousDays[index]}
                    onOpenFile={onOpenFile}
                />
            ))}
        </div>
    );
}
