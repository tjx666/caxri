import type { AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';

import { summarizeToolGroup } from './tool-presentation';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

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
        summary: summarizeToolGroup(tools),
        durationMs,
    };
};

export const groupConversationItems = (items: AgentTimelineItem[]): ConversationEntry[] => {
    const entries: ConversationEntry[] = [];
    let tools: ToolCall[] = [];
    const flushTools = (): void => {
        if (tools.length > 0) entries.push(toolGroup(tools));
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

export const formatConversationDuration = (durationMs: number | undefined): string | null => {
    if (durationMs === undefined) return null;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
};
