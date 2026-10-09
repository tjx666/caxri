import { shouldFallbackToTerminal } from '../conversation/conversation-model';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import type { MobileTerminal } from './session-model';

/**
 * A Project view mirrored from Desktop's right sidebar (Files, Status, or an extension panel), keyed by its panel id.
 * Each one is its own top-level tab instead of a nested Project tab, so a view is one tap away.
 */
export type PanelSessionSegment = `panel:${string}`;

export type SessionSegment = 'conversation' | 'terminal' | 'changes' | PanelSessionSegment;

/**
 * The fixed tabs in the Session header, left to right. Panel tabs follow them in the Server's panel order.
 */
export const SESSION_SEGMENTS = ['conversation', 'terminal', 'changes'] as const;

export const panelSessionSegment = (panelId: string): PanelSessionSegment => `panel:${panelId}`;

export const isPanelSessionSegment = (segment: SessionSegment): segment is PanelSessionSegment =>
    segment.startsWith('panel:');

export const panelIdOfSegment = (segment: PanelSessionSegment): string =>
    segment.slice('panel:'.length);

/**
 * Which way the tab strip moved, so the incoming panel can slide in from that side: `1` toward a later tab, `-1` toward
 * an earlier one, and `0` when nothing changed. A panel tab missing from `order` (still loading) counts as last.
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
 * Side segments inspect the workspace rather than the Agent. On a wide tablet they open beside the last content
 * segment, so switching to one must remember which content segment to keep showing.
 */
export const isSideSessionSegment = (
    segment: SessionSegment,
): segment is 'changes' | PanelSessionSegment =>
    segment === 'changes' || isPanelSessionSegment(segment);

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
    contentSegmentBySession: Record<string, 'conversation' | 'terminal'>;
    draftBySession: Record<string, string>;
    projectId: string | null;
    segmentBySession: Record<string, SessionSegment>;
}

export const emptyHostSessionUiState = (): HostSessionUiState => ({
    contentSegmentBySession: {},
    draftBySession: {},
    projectId: null,
    segmentBySession: {},
});

export const preferredSessionSegment = (
    remembered: SessionSegment | undefined,
    isConversationAvailable: boolean,
): SessionSegment => remembered ?? (isConversationAvailable ? 'conversation' : 'terminal');

export const hasKnownConversationAgent = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): boolean =>
    terminal?.kind === 'claude' ||
    terminal?.kind === 'codex' ||
    terminal?.provider === 'claude' ||
    terminal?.provider === 'codex';

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
});

export const rememberSessionDraft = (
    state: HostSessionUiState,
    sessionId: string,
    draft: string,
): HostSessionUiState => ({
    ...state,
    draftBySession: { ...state.draftBySession, [sessionId]: draft },
});

export const selectSessionProject = (
    state: HostSessionUiState,
    projectId: string | null,
): HostSessionUiState => ({ ...state, projectId });
