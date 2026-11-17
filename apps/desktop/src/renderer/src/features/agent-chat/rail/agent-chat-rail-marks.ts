import { agentChatPathReferencePreview, parseRelayedSessionMessage } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';

/**
 * One mark on the message rail: a user message the rail can jump to, and how its tick and its row in the rail's list
 * show it.
 */
export interface AgentChatRailMark {
    id: string;
    /**
     * The start of the message on one line: the label of its row in the rail's list, and its accessible name.
     */
    preview: string;
    /**
     * The tick's length in pixels, longer for a longer message ({@link agentChatRailTickWidth}), so the rail reads as a
     * sketch of the conversation's shape.
     */
    width: number;
    /**
     * False while the message has no content to show yet (no text and no images); its row then holds a skeleton bar
     * instead of an empty label.
     */
    isReady: boolean;
}

/**
 * The attribute every user message carries in the transcript (`AgentChatUserMessage`), holding its item id, so the rail
 * can find it to measure and scroll to.
 */
export const AGENT_CHAT_USER_MESSAGE_ATTRIBUTE = 'data-agent-chat-user-message';

const PREVIEW_LENGTH = 120;

/**
 * The most marks the rail holds: about as many as a rail in an ordinary window can space apart, and as many rows as its
 * list stays quick to scan and render. History read back has no bound, so thousands of marks would neither read nor
 * render cheaply.
 */
export const MAX_AGENT_CHAT_RAIL_MARKS = 120;

/**
 * The shortest and longest tick, and the message width (in {@link displayWidth} units) at which a tick reaches its full
 * length.
 */
const TICK_MIN_PX = 6;
const TICK_MAX_PX = 16;
const TICK_FULL_WIDTH = 80;

/**
 * Whether the message rail shows: a conversation with one message has nowhere to jump, so it appears from the second.
 * The transcript reads the same rule to make room for the rail.
 */
export function isAgentChatMessageRailShown(marks: readonly AgentChatRailMark[]): boolean {
    return marks.length >= 2;
}

/**
 * A rough display width: a CJK or other full-width character takes about two Latin letters' room.
 */
function displayWidth(text: string): number {
    let width = 0;
    for (const character of text) width += (character.codePointAt(0) ?? 0) >= 0x2e_80 ? 2 : 1;
    return width;
}

/**
 * How long a message's tick is: a square-root curve from {@link TICK_MIN_PX} for an empty message to {@link TICK_MAX_PX}
 * at {@link TICK_FULL_WIDTH}, so short messages already differ from each other and long ones do not all pile up at the
 * maximum at once.
 */
export function agentChatRailTickWidth(text: string): number {
    const width = displayWidth(text.replaceAll(/\s+/gu, ' ').trim());
    const ratio = Math.min(Math.sqrt(width / TICK_FULL_WIDTH), 1);
    return Math.round(TICK_MIN_PX + (TICK_MAX_PX - TICK_MIN_PX) * ratio);
}

/**
 * The start of a message on one line, collapsed and cut to fit a row. A message of images alone says so.
 */
export function agentChatRailPreview(text: string, imageCount: number, t: Translate): string {
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
 * finished turn folds only work and commentary), so nested entries are not searched. A delegated task previews the task
 * its caller wrote, not the pointer that stands in for it, and a relayed message previews the text it carries, not the
 * `[Caxri] Relayed from` protocol line.
 */
export function agentChatRailMarks(
    timeline: readonly AgentChatTimelineEntry[],
    t: Translate,
): AgentChatRailMark[] {
    const marks: AgentChatRailMark[] = [];
    for (const entry of timeline) {
        // A delivered settlement notice is a compact row, not a message of the conversation worth a rail mark.
        if (
            entry.kind !== 'item' ||
            entry.item.type !== 'userMessage' ||
            entry.item.delegationNotice
        )
            continue;
        const { id, text, images, delegatedTask } = entry.item;
        const imageCount = images?.length ?? 0;
        const words = delegatedTask
            ? (delegatedTask.prompt ?? t('agentChat.delegated.task'))
            : agentChatPathReferencePreview(parseRelayedSessionMessage(text)?.text ?? text);
        marks.push({
            id,
            preview: agentChatRailPreview(words, imageCount, t),
            width: agentChatRailTickWidth(words),
            isReady: words.trim() !== '' || imageCount > 0,
        });
    }
    return marks;
}

/**
 * The indices of at most `limit` of `count` marks, spread evenly from the first to the last, so a long conversation
 * keeps a rail of the same shape whose ticks each stand for a stretch of it. Every index while `count` fits.
 */
export function agentChatRailSampleIndices(count: number, limit: number): number[] {
    if (count <= limit) return Array.from({ length: count }, (_, index) => index);
    if (limit <= 1) return count > 0 ? [count - 1] : [];
    const step = (count - 1) / (limit - 1);
    return Array.from({ length: limit }, (_, index) => Math.round(index * step));
}

/**
 * At most {@link MAX_AGENT_CHAT_RAIL_MARKS} of `marks`, spread evenly from the first message to the last (see
 * {@link agentChatRailSampleIndices}).
 */
export function sampleAgentChatRailMarks(
    marks: readonly AgentChatRailMark[],
): readonly AgentChatRailMark[] {
    if (marks.length <= MAX_AGENT_CHAT_RAIL_MARKS) return marks;
    return agentChatRailSampleIndices(marks.length, MAX_AGENT_CHAT_RAIL_MARKS).map(
        (index) => marks[index],
    );
}

/**
 * The smallest height a tick keeps, so ticks stay apart; ticks that would shrink below it merge instead
 * ({@link agentChatRailTickCapacity}).
 */
const AGENT_CHAT_RAIL_TICK_MIN_PX = 6;

/**
 * How many ticks fit a rail `height` pixels tall at {@link AGENT_CHAT_RAIL_TICK_MIN_PX} each, never fewer than the two
 * the rail appears with.
 */
export function agentChatRailTickCapacity(height: number): number {
    return Math.max(2, Math.floor(height / AGENT_CHAT_RAIL_TICK_MIN_PX));
}

/**
 * The tick that stands for the mark at `activeIndex` once marks were sampled to `indices`: the last tick at or before
 * it, so the rail lights the stretch the reader is in. `-1` while no mark is active.
 */
export function agentChatRailActiveTick(indices: readonly number[], activeIndex: number): number {
    if (activeIndex < 0) return -1;
    let tick = -1;
    for (const [position, index] of indices.entries()) {
        if (index > activeIndex) break;
        tick = position;
    }
    return tick;
}

/**
 * Where a key moves keyboard focus among the list's `count` rows from `current`, the list being one Tab stop with arrow
 * keys inside it: Up and Down step and stop at either end, Home and End jump there. `undefined` for any other key.
 */
export function agentChatRailFocusStep(
    current: number,
    count: number,
    key: string,
): number | undefined {
    if (count === 0) return undefined;
    switch (key) {
        case 'ArrowUp': {
            return Math.max(current - 1, 0);
        }
        case 'ArrowDown': {
            return Math.min(current + 1, count - 1);
        }
        case 'Home': {
            return 0;
        }
        case 'End': {
            return count - 1;
        }
        default: {
            return undefined;
        }
    }
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
