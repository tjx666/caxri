import type { AgentProvider } from '@caxri/protocol';

import { shouldFallbackToTerminal } from '../conversation/conversation-model';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import type { MobileTerminal } from './session-model';

/**
 * A Project view mirrored from Desktop's Secondary Side Bar (Files, Status, or an extension panel), keyed by its panel
 * id. Each one is its own tab in the Session's side panel, beside Changes, so a view is one tap away once it is open.
 */
export type PanelSessionSegment = `panel:${string}`;

export type ContentSessionSegment = 'conversation' | 'terminal';

export type SideSessionSegment = 'changes' | PanelSessionSegment;

export type SessionSegment = ContentSessionSegment | SideSessionSegment;

/**
 * The fixed segments in order: the two content segments, then Changes, the side panel's first tab. Panel segments
 * follow it in the Server's panel order.
 */
export const SESSION_SEGMENTS = ['conversation', 'terminal', 'changes'] as const;

export const panelSessionSegment = (panelId: string): PanelSessionSegment => `panel:${panelId}`;

export const isPanelSessionSegment = (segment: SessionSegment): segment is PanelSessionSegment =>
    segment.startsWith('panel:');

export const panelIdOfSegment = (segment: PanelSessionSegment): string =>
    segment.slice('panel:'.length);

/**
 * Which way a switch moved through `order`, so the incoming segment can slide in from that side: `1` toward a later
 * segment, `-1` toward an earlier one, and `0` when nothing changed. A panel segment missing from `order` (still
 * loading) counts as last.
 */
export const sessionSegmentDirection = (
    from: SessionSegment,
    to: SessionSegment,
    order: readonly SessionSegment[],
): -1 | 0 | 1 => {
    const position = (segment: SessionSegment): number => {
        const index = order.indexOf(segment);
        return index === -1 ? order.length : index;
    };
    return from === to ? 0 : (Math.sign(position(to) - position(from)) as -1 | 0 | 1);
};

/**
 * The fixed segments a Session offers: Conversation only when there is one to show, and no Terminal for a Chat, which
 * has no PTY to attach.
 */
export const sessionSegments = ({
    hasConversation,
    isChat,
}: {
    hasConversation: boolean;
    isChat: boolean;
}): SessionSegment[] =>
    SESSION_SEGMENTS.filter(
        (option) =>
            (hasConversation || option !== 'conversation') && !(isChat && option === 'terminal'),
    );

/**
 * Side segments inspect the workspace rather than the Agent, as Desktop's Secondary Side Bar does. They open in the
 * side panel: a drawer over the last content segment on a phone, a pane beside it on a wide tablet. Either way that
 * content segment stays mounted, so switching to a side segment must remember which one it was.
 */
export const isSideSessionSegment = (segment: SessionSegment): segment is SideSessionSegment =>
    segment === 'changes' || isPanelSessionSegment(segment);

/**
 * The content segment on screen: the selected one, or `remembered`, the one an open side panel covers or sits beside. A
 * Chat has no Terminal, so it always shows its conversation.
 */
export const shownContentSegment = (
    segment: SessionSegment,
    remembered: ContentSessionSegment,
    isChat: boolean,
): ContentSessionSegment =>
    isChat ? 'conversation' : isSideSessionSegment(segment) ? remembered : segment;

/**
 * The side segment the side panel button opens: the one the user last had open, while the Session still offers it (a
 * Project view can go away), else Changes.
 */
export const sideSegmentToOpen = (
    remembered: SideSessionSegment | undefined,
    offered: readonly SessionSegment[],
): SideSessionSegment =>
    remembered !== undefined && offered.includes(remembered) ? remembered : 'changes';

/**
 * Whether a Chat is on screen: its own segment, or the conversation an open side panel covers or sits beside, which
 * stays mounted under every side segment alike. Only the Terminal, which a Chat never has, leaves it.
 */
export const isChatSegmentShown = (segment: SessionSegment): boolean => segment !== 'terminal';

/**
 * Whether the side panel's close button shows the pending-answer dot: a Chat waits on the user (a pending approval or
 * question) while a phone's side panel drawer covers it, so the request is not missed. A wide tablet's pane leaves the
 * Chat in view, and the Chat itself already shows the request.
 */
export const isChatAwaitingBehindSidePanel = ({
    agentActivityState,
    isChat,
    isCovered,
}: {
    agentActivityState: string;
    isChat: boolean;
    isCovered: boolean;
}): boolean => isChat && isCovered && agentActivityState === 'waiting';

/**
 * Whether the selected Session's detail is on screen. A phone shows it only on its own route; a tablet shows it beside
 * the list. A covered route stays mounted under the navigation Stack but counts as hidden.
 */
export const isSessionDetailVisible = ({
    isFocused,
    isPhone,
    isRouted,
    isSelected,
}: {
    isFocused: boolean;
    isPhone: boolean;
    isRouted: boolean;
    isSelected: boolean;
}): boolean => isFocused && isSelected && (!isPhone || isRouted);

export interface HostSessionUiState {
    contentSegmentBySession: Record<string, ContentSessionSegment>;
    draftBySession: Record<string, string>;
    projectId: string | null;
    segmentBySession: Record<string, SessionSegment>;
    /**
     * The side segment each Session last showed, so its side panel button reopens that view.
     */
    sideSegmentBySession: Record<string, SideSessionSegment>;
}

export const emptyHostSessionUiState = (): HostSessionUiState => ({
    contentSegmentBySession: {},
    draftBySession: {},
    projectId: null,
    segmentBySession: {},
    sideSegmentBySession: {},
});

export const preferredSessionSegment = (
    remembered: SessionSegment | undefined,
    isConversationAvailable: boolean,
): SessionSegment => remembered ?? (isConversationAvailable ? 'conversation' : 'terminal');

/**
 * Providers whose Conversation timeline the Server can project (their descriptor declares a `timelineProjector`). This
 * fail-closed copy lets a newly launched Agent show its tab before any timeline loads. Keyed by `AgentProvider` so a
 * newly catalogued provider fails to compile until it takes a side here; the Server test in
 * `apps/server/src/domains/agents/providers/__tests__/providers.test.ts` pins the same set so the two cannot drift.
 */
const CONVERSATION_TIMELINE_PROVIDERS: Record<AgentProvider, boolean> = {
    claude: true,
    codex: true,
    grok: false,
    antigravity: false,
};

const hasConversationTimeline = (identity: MobileTerminal['kind'] | undefined): boolean =>
    identity !== undefined && identity !== 'shell' && CONVERSATION_TIMELINE_PROVIDERS[identity];

export const hasKnownConversationAgent = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): boolean =>
    hasConversationTimeline(terminal?.kind) || hasConversationTimeline(terminal?.provider);

/**
 * A plain shell has no Conversation to show, so it gets no Conversation tab and no "isn't available" notice: both would
 * describe an Agent the user never started. A timeline that turns up anyway, or one the user was already reading and is
 * still loading, keeps the tab.
 */
export const resolveSessionConversationSegment = ({
    hasAgentEndpoint,
    hasKnownAgent,
    isChat = false,
    remembered,
    status,
}: {
    hasAgentEndpoint: boolean;
    hasKnownAgent: boolean;
    /**
     * A Chat has no PTY, so its conversation tab is always available and a remembered Terminal tab falls back to it.
     */
    isChat?: boolean;
    remembered: SessionSegment | undefined;
    status: ConversationTimelineState['status'];
}): { fallback: boolean; hasConversation: boolean; segment: SessionSegment } => {
    if (isChat)
        return {
            fallback: false,
            hasConversation: true,
            segment:
                remembered === undefined || remembered === 'terminal' ? 'conversation' : remembered,
        };
    const hasConversation =
        hasAgentEndpoint ||
        hasKnownAgent ||
        status === 'available' ||
        (remembered === 'conversation' && status === 'loading');
    if (!hasConversation)
        return {
            fallback: false,
            hasConversation,
            segment:
                remembered === undefined || remembered === 'conversation' ? 'terminal' : remembered,
        };
    const fallback =
        (remembered === undefined || remembered === 'conversation') &&
        shouldFallbackToTerminal(status);
    const available =
        status === 'available' ||
        (hasAgentEndpoint && !fallback) ||
        (hasKnownAgent && status === 'loading');
    return {
        fallback,
        hasConversation,
        segment: fallback ? 'terminal' : preferredSessionSegment(remembered, available),
    };
};

export const rememberSessionSegment = (
    state: HostSessionUiState,
    sessionId: string,
    segment: SessionSegment,
    previous?: SessionSegment,
): HostSessionUiState => ({
    ...state,
    contentSegmentBySession: {
        ...state.contentSegmentBySession,
        ...(isSideSessionSegment(segment)
            ? previous && !isSideSessionSegment(previous)
                ? { [sessionId]: previous }
                : {}
            : { [sessionId]: segment }),
    },
    segmentBySession: { ...state.segmentBySession, [sessionId]: segment },
    sideSegmentBySession: isSideSessionSegment(segment)
        ? { ...state.sideSegmentBySession, [sessionId]: segment }
        : state.sideSegmentBySession,
});

/**
 * Keeps `draftBySession` in recency order, newest last, and drops an emptied draft, so the saved copy can keep the
 * newest drafts by position alone.
 */
export const rememberSessionDraft = (
    state: HostSessionUiState,
    sessionId: string,
    draft: string,
): HostSessionUiState => {
    const draftBySession = { ...state.draftBySession };
    delete draftBySession[sessionId];
    if (draft !== '') draftBySession[sessionId] = draft;
    return { ...state, draftBySession };
};

export const selectSessionProject = (
    state: HostSessionUiState,
    projectId: string | null,
): HostSessionUiState => ({ ...state, projectId });
