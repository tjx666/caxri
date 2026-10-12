import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';

/**
 * One mark on the message rail: a user message the rail can jump to.
 */
export interface AgentChatRailMark {
    id: string;
    /**
     * The start of the message, for the mark's hover preview.
     */
    preview: string;
}

/**
 * The attribute every user message carries in the transcript (`AgentChatUserMessage`), holding its item id, so the rail
 * can find it to measure and scroll to.
 */
export const AGENT_CHAT_USER_MESSAGE_ATTRIBUTE = 'data-agent-chat-user-message';

const PREVIEW_LENGTH = 120;

/**
 * The most ticks the rail draws: about as many as a rail in an ordinary window can space apart. Past it the ticks merge
 * into a solid bar, and history read back has no bound, so thousands of ticks would neither read nor render cheaply.
 */
export const MAX_AGENT_CHAT_RAIL_MARKS = 120;

/**
 * Whether the message rail shows: a conversation with one message has nowhere to jump, so it appears from the second.
 * The transcript reads the same rule to make room for the rail at its left edge.
 */
export function isAgentChatMessageRailShown(marks: readonly AgentChatRailMark[]): boolean {
    return marks.length >= 2;
}

/**
 * The first line of a message, collapsed and cut to fit a tooltip. A message of images alone says so.
 */
export function agentChatRailPreview(
    text: string,
    imageCount: number,
    t: Translate = translate,
): string {
    const line = text.replaceAll(/\s+/gu, ' ').trim();
    if (!line)
        return imageCount === 1
            ? t('agentChat.rail.image')
            : imageCount > 1
              ? t('agentChat.rail.images', { count: imageCount })
              : '';
    return line.length <= PREVIEW_LENGTH ? line : `${line.slice(0, PREVIEW_LENGTH - 1)}…`;
}

/**
 * The rail's marks, one per user message in transcript order. User messages always stay at the timeline's top level (a
 * finished turn folds only work and commentary), so nested entries are not searched.
 */
export function agentChatRailMarks(
    timeline: readonly AgentChatTimelineEntry[],
    t: Translate = translate,
): AgentChatRailMark[] {
    const marks: AgentChatRailMark[] = [];
    for (const entry of timeline) {
        if (entry.kind !== 'item' || entry.item.type !== 'userMessage') continue;
        const { id, text, images } = entry.item;
        marks.push({ id, preview: agentChatRailPreview(text, images?.length ?? 0, t) });
    }
    return marks;
}

/**
 * At most {@link MAX_AGENT_CHAT_RAIL_MARKS} of `marks`, spread evenly from the first message to the last, so a long
 * conversation keeps a rail of the same shape whose ticks each stand for a stretch of it.
 */
export function sampleAgentChatRailMarks(
    marks: readonly AgentChatRailMark[],
): readonly AgentChatRailMark[] {
    if (marks.length <= MAX_AGENT_CHAT_RAIL_MARKS) return marks;
    const step = (marks.length - 1) / (MAX_AGENT_CHAT_RAIL_MARKS - 1);
    return Array.from(
        { length: MAX_AGENT_CHAT_RAIL_MARKS },
        (_, index) => marks[Math.round(index * step)],
    );
}

/**
 * Which mark the reader is at: the last message whose top has scrolled above the reading line (a third of the way down
 * the view), or the last message when the view is at the end, where a short final exchange may never reach that line.
 * `-1` while every message is still below the line.
 */
export function agentChatActiveRailIndex(
    tops: readonly number[],
    readingLine: number,
    isAtEnd: boolean,
): number {
    if (isAtEnd) return tops.length - 1;
    let active = -1;
    for (const [index, top] of tops.entries()) {
        if (top > readingLine) break;
        active = index;
    }
    return active;
}
