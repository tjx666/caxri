import { agentChatPathReferencePreview } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';

/**
 * What a rail mark's message is, for the badge in its preview card's corner: a plain message, one steered into a
 * running turn, a delegated task, or images alone. Queued messages read as plain ones, as they do in the transcript.
 */
export type AgentChatRailMarkKind = 'delegated' | 'images' | 'message' | 'steered';

/**
 * One mark on the message rail: a user message the rail can jump to, and what its preview card shows.
 */
export interface AgentChatRailMark {
    id: string;
    /**
     * The start of the message on one line, for the tick's accessible name.
     */
    preview: string;
    /**
     * The card's heading: the message's first line, or its first sentence when that line runs long. Empty when the
     * first line is too long for any title to show whole; the summary then carries the full text and the card heads
     * itself with the message's position (see {@link agentChatRailCardText}).
     */
    title: string;
    /**
     * The card's body: what follows the title (never the title itself), with the message's line breaks kept. The card
     * clamps it to three lines.
     */
    summary: string;
    /**
     * When the message entered the conversation, in epoch milliseconds, when the timeline knows it.
     */
    createdAt?: number;
    kind: AgentChatRailMarkKind;
    /**
     * False while the message has no content to show yet (no text and no images), when the card holds its skeleton
     * instead of an empty frame. Content that is already in the timeline is never held back behind it.
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
 * About as wide as the card's title row shows beside its badge, in {@link titleWidth} units. A first line wider than
 * this would be cut by the title's ellipsis, so it is not used as the title on its own.
 */
const TITLE_WIDTH = 28;

/**
 * The most of the body the card is handed; three clamped lines never show more.
 */
const SUMMARY_LENGTH = 400;

const SENTENCE_END = /[.!?。！？]/gu;

/**
 * A rough display width: a CJK or other full-width character takes about two Latin letters' room.
 */
function titleWidth(text: string): number {
    let width = 0;
    for (const character of text) width += (character.codePointAt(0) ?? 0) >= 0x2e_80 ? 2 : 1;
    return width;
}

/**
 * The title for a message whose first line is `line`, and what the summary shows after it. A line that fits is the
 * title; a long line whose first sentence fits is titled by that sentence. Any other long line gets an empty title and
 * stays whole in the summary: a title cut where the row's ellipsis lands would repeat the start of the summary, so the
 * rule is that the title and summary never share text. The card heads such a message with its position instead.
 */
function splitTitle(line: string): { title: string; rest: string } {
    if (titleWidth(line) <= TITLE_WIDTH) return { title: line, rest: '' };
    for (const match of line.matchAll(SENTENCE_END)) {
        const end = match.index + 1;
        const after = line.charAt(end);
        if (after !== '' && after !== ' ' && titleWidth(match[0]) === 1) continue;
        if (titleWidth(line.slice(0, end)) > TITLE_WIDTH) break;
        return { title: line.slice(0, end), rest: line.slice(end).trim() };
    }
    // The row clips the title; past this it only costs memory per mark.
    return { title: '', rest: line };
}

/**
 * The title and summary of a message's preview card. Each line is collapsed to single spaces and blank lines are
 * dropped, so a summary spends its three lines on words; a message of images alone is named by its images.
 */
export function agentChatRailPreviewParts(
    text: string,
    imageCount: number,
    t: Translate,
): { title: string; summary: string } {
    const lines = text
        .split(/\r?\n/u)
        .map((line) => line.replaceAll(/\s+/gu, ' ').trim())
        .filter(Boolean);
    if (lines.length === 0)
        return {
            title: agentChatRailPreview('', imageCount, t),
            summary: imageCount > 0 ? t('agentChat.rail.imagesOnly') : '',
        };
    const { title, rest } = splitTitle(lines[0]);
    const summary = [rest, ...lines.slice(1)].filter(Boolean).join('\n');
    return {
        title,
        summary:
            summary.length <= SUMMARY_LENGTH ? summary : `${summary.slice(0, SUMMARY_LENGTH - 1)}…`,
    };
}

/**
 * The rail's marks, one per user message in transcript order. User messages always stay at the timeline's top level (a
 * finished turn folds only work and commentary), so nested entries are not searched. A delegated task previews the task
 * its caller wrote, not the pointer that stands in for it.
 */
export function agentChatRailMarks(
    timeline: readonly AgentChatTimelineEntry[],
    t: Translate,
): AgentChatRailMark[] {
    const marks: AgentChatRailMark[] = [];
    for (const entry of timeline) {
        if (entry.kind !== 'item' || entry.item.type !== 'userMessage') continue;
        const { id, text, images, delivery, delegatedTask, createdAt } = entry.item;
        const imageCount = images?.length ?? 0;
        const words = delegatedTask
            ? (delegatedTask.prompt ?? t('agentChat.delegated.task'))
            : agentChatPathReferencePreview(text);
        const isReady = words.trim() !== '' || imageCount > 0;
        marks.push({
            id,
            preview: agentChatRailPreview(words, imageCount, t),
            ...agentChatRailPreviewParts(words, imageCount, t),
            kind: delegatedTask
                ? 'delegated'
                : delivery === 'steered'
                  ? 'steered'
                  : words.trim() === '' && imageCount > 0
                    ? 'images'
                    : 'message',
            isReady,
            ...(createdAt !== undefined && { createdAt }),
        });
    }
    return marks;
}

/**
 * How the rail card formats a message's send time: the clock alone for a message sent today, and the month and day
 * before it otherwise, so a message from last week does not read as sent today.
 */
export function agentChatRailTimeFormatOptions(
    createdAt: number,
    now: number,
): Intl.DateTimeFormatOptions {
    const sent = new Date(createdAt);
    const today = new Date(now);
    const isToday =
        sent.getFullYear() === today.getFullYear() &&
        sent.getMonth() === today.getMonth() &&
        sent.getDate() === today.getDate();
    const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    return isToday ? clock : { month: 'short', day: 'numeric', ...clock };
}

/**
 * Where a message sits in the conversation, as the card words it: "Message 3 of 12", with the time appended when the
 * timeline knows it (`time` is already formatted for the interface language). The rail only holds loaded messages, so
 * while earlier history is still unloaded (`total` undefined) the position would be wrong: the card then names the time
 * alone, or the position among the loaded messages when there is no time.
 */
export function agentChatRailCaption(
    position: number,
    total: number | undefined,
    loadedCount: number,
    time: string | undefined,
    t: Translate,
): string {
    if (total === undefined)
        return time
            ? t('agentChat.rail.sentAt', { time })
            : t('agentChat.rail.positionLoaded', { position, total: loadedCount });
    return time
        ? t('agentChat.rail.positionTime', { position, total, time })
        : t('agentChat.rail.position', { position, total });
}

/**
 * The words of a preview card. A mark with a title keeps it, and its body is the summary, or, when the message has
 * nothing after the title, the muted `caption` so the fixed three-line body never reads as a failed load. A mark whose
 * title is empty (a first line too long to show whole) takes the caption as its heading and keeps the full text as the
 * body. The title and body therefore never repeat each other.
 */
export function agentChatRailCardText(
    mark: Pick<AgentChatRailMark, 'summary' | 'title'>,
    caption: string,
): { title: string; body: string; isBodyCaption: boolean } {
    if (!mark.title) return { title: caption, body: mark.summary, isBodyCaption: false };
    if (!mark.summary) return { title: mark.title, body: caption, isBodyCaption: true };
    return { title: mark.title, body: mark.summary, isBodyCaption: false };
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
 * The smallest height a tick's button keeps, so each stays a target a pointer can hit; ticks that would shrink below it
 * merge instead ({@link agentChatRailTickCapacity}).
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
 * How far from the conversation area's left edge the pointer reveals the rail: the rail's own width plus the margin a
 * reader's pointer drifts by on its way to a tick.
 */
const AGENT_CHAT_RAIL_GUTTER_PX = 40;

/**
 * Whether a pointer at `pointerX` is in the left gutter of a conversation area whose left edge is at `areaLeft`, where
 * the rail shows itself.
 */
export function isAgentChatRailGutter(pointerX: number, areaLeft: number): boolean {
    const offset = pointerX - areaLeft;
    return offset >= 0 && offset <= AGENT_CHAT_RAIL_GUTTER_PX;
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
 * Where a key moves keyboard focus among `count` ticks from `current`, the rail being one Tab stop with arrow keys
 * inside it: Up and Down step and stop at either end, Home and End jump there. `undefined` for any other key.
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
