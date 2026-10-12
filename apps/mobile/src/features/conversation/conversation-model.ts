import type { AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';
import { agentChatTurnLabel, summarizeAgentToolGroup } from '@caxri/protocol';

import { agentChatTurnTone } from '../agent-chat/agent-chat-timeline';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;
type TurnBoundary = Extract<AgentTimelineItem, { type: 'turnBoundary' }>;

/**
 * The caption and tone of a terminal Agent's turn divider, in the words and tones an Agent Chat footer uses (`Worked
 * for 4s`, `Stopped after 4s`, `Failed`). A boundary whose record does not say how the turn ended reads as completed
 * work.
 */
export const conversationTurnDivider = (
    boundary: Pick<TurnBoundary, 'durationMs' | 'outcome'>,
): { label: string; tone: 'danger' | 'muted' | 'warning' } => {
    const status = boundary.outcome ?? 'completed';
    return {
        label: agentChatTurnLabel({ durationMs: boundary.durationMs, status }),
        tone: agentChatTurnTone(status),
    };
};

export type ConversationAvailability =
    MobileTimelineReadResult['status'] | 'loading' | 'error' | 'stale';

export interface ConversationHistoryState {
    historyExpired: boolean;
    items: AgentTimelineItem[];
    olderCursor?: string;
    truncated: boolean;
}

export type ConversationEntry =
    | AgentTimelineItem
    | { id: string; type: 'toolGroup'; tools: ToolCall[]; summary: string; durationMs?: number };

const toolGroup = (tools: ToolCall[]): ConversationEntry => {
    if (tools.length === 1) return tools[0];
    const durationMs = tools.every((tool) => tool.durationMs !== undefined)
        ? tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0)
        : undefined;
    return {
        id: `tools:${tools[0].id}`,
        type: 'toolGroup',
        tools,
        summary: summarizeAgentToolGroup(tools),
        durationMs,
    };
};

/**
 * Collapses each run of consecutive tool calls into one group row. A tool still running stays out of the group as its
 * own row after it, as Desktop's Agent Chat keeps live work out of its summaries, so the step in progress stays
 * readable.
 */
export const groupConversationItems = (items: AgentTimelineItem[]): ConversationEntry[] => {
    const entries: ConversationEntry[] = [];
    let tools: ToolCall[] = [];
    const flushTools = (): void => {
        const settled = tools.filter((tool) => tool.status !== 'running');
        if (settled.length > 0) entries.push(toolGroup(settled));
        entries.push(...tools.filter((tool) => tool.status === 'running'));
        tools = [];
    };
    for (const item of items) {
        if (item.type === 'toolCall') tools.push(item);
        else {
            flushTools();
            entries.push(item);
        }
    }
    flushTools();
    return entries;
};

/**
 * A latest-page refresh replaces the overlapping suffix, including streaming edits to existing IDs.
 */
export const mergeLatestConversationItems = (
    current: AgentTimelineItem[],
    latest: AgentTimelineItem[],
): AgentTimelineItem[] => {
    if (latest.length === 0) return [];
    const overlap = current.findIndex((item) => item.id === latest[0].id);
    if (overlap === -1) return latest;
    return [...current.slice(0, overlap), ...latest];
};

/**
 * The pagination cursor belongs to the oldest retained item, not the newest live page. Adopt a new cursor only when a
 * disjoint page replaces the retained history.
 */
export const applyLatestConversationPage = <State extends ConversationHistoryState>(
    current: State,
    page: MobileTimelineReadResult,
): State => {
    const retainsHistory =
        page.status === 'available' &&
        page.items.length > 0 &&
        current.items.some((item) => item.id === page.items[0].id);
    return {
        ...current,
        items:
            page.status === 'available'
                ? mergeLatestConversationItems(current.items, page.items)
                : [],
        olderCursor: retainsHistory ? current.olderCursor : page.olderCursor,
        truncated: retainsHistory ? current.truncated : page.truncated,
    };
};

export const prependConversationPage = (
    current: AgentTimelineItem[],
    page: MobileTimelineReadResult,
): AgentTimelineItem[] => {
    if (page.cursorExpired) return page.items;
    const existing = new Set(current.map((item) => item.id));
    return [...page.items.filter((item) => !existing.has(item.id)), ...current];
};

/**
 * A live invalidation can update the newest page while an older cursor remains valid.
 */
export const applyOlderConversationPage = <State extends ConversationHistoryState>(
    current: State,
    page: MobileTimelineReadResult,
    requestedCursor: string,
): State => {
    if (!page.cursorExpired && current.olderCursor !== requestedCursor) return current;
    return {
        ...current,
        historyExpired: current.historyExpired || page.cursorExpired,
        items: prependConversationPage(current.items, page),
        olderCursor: page.olderCursor,
        truncated: page.truncated,
    };
};

export const shouldFallbackToTerminal = (status: ConversationAvailability): boolean =>
    status === 'unsupported' || status === 'missing';

export const visibleConversationStatus = (
    status: ConversationAvailability,
    isObservable: boolean,
): ConversationAvailability =>
    isObservable || shouldFallbackToTerminal(status) ? status : 'stale';

/**
 * A back-navigation pop keeps the leaving Session screen mounted and visible while it slides off, and React Navigation
 * blurs it (`isFocused` -> false) at the very start of that transition. Feeding that immediate blur into
 * `visibleConversationStatus` inserts the stale-Conversation notice above the list mid-transition, a re-layout of a
 * screen the user is already leaving (#1329). `isStaleAfterBlur` is a timer the hook only commits to `true` after this
 * many milliseconds of continuous non-observability, so a pop transition (well under it) finishes before the row would
 * ever render, while a real backgrounding or a screen left covered still falls back to `stale` once the window
 * elapses.
 */
export const CONVERSATION_BLUR_GRACE_MS = 500;

export const isConversationObservableThroughBlur = (
    isObservable: boolean,
    isStaleAfterBlur: boolean,
): boolean => isObservable || !isStaleAfterBlur;

/**
 * FlashList measures autoscroll thresholds in viewport lengths; share that unit with the Jump control.
 * https://github.com/Shopify/flash-list/blob/v2.0.2/src/recyclerview/hooks/useBoundDetection.ts
 */
export const CONVERSATION_FOLLOW_THRESHOLD = 0.1;

export const shouldFollowConversation = (
    distanceFromBottom: number,
    viewportHeight: number,
): boolean => distanceFromBottom <= viewportHeight * CONVERSATION_FOLLOW_THRESHOLD;

export const shouldShowConversationJump = (isAtBottom: boolean, hasNewContent: boolean): boolean =>
    !isAtBottom && hasNewContent;

/**
 * How long after the user's own send the list keeps following while its animated scroll to the end runs. The scroll
 * passes through offsets above the follow threshold, and a keyboard closing or a new row measuring mid-scroll moves the
 * end again; without the hold, either would read as the reader scrolling away and bring back the Jump control.
 */
export const CONVERSATION_SEND_FOLLOW_HOLD_MS = 600;

/**
 * Whether a scroll leaves the list following its end: a reader near the end follows, and so does any offset passed
 * while the list is still carrying the user to their own message (`holdUntil`).
 */
export const isConversationFollowing = (
    distanceFromBottom: number,
    viewportHeight: number,
    now: number,
    holdUntil: number,
): boolean => shouldFollowConversation(distanceFromBottom, viewportHeight) || now < holdUntil;

/**
 * Whether the user sent a message since the list last looked (`previous`): Desktop returns to the end after its own
 * send, while new Agent output never pulls a reader who scrolled up back down. The first value a list sees is a
 * baseline, so remounting a list never counts as a send.
 */
export const isNewConversationSend = (previous: number | undefined, next: number | undefined) =>
    previous !== undefined && next !== undefined && next > previous;

/**
 * Carries the list to its newest row after the user's own send. FlashList places a row from its estimated height and
 * corrects the offset once the row measures, so the scroll repeats on the next frame to land on the real end.
 */
export const followConversationToLatest = ({
    follow,
    nextFrame,
    scrollToEnd,
}: {
    follow: () => void;
    nextFrame: (run: () => void) => void;
    scrollToEnd: () => void;
}): void => {
    follow();
    scrollToEnd();
    nextFrame(scrollToEnd);
};
