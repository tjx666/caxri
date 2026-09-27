import { shouldFallbackToTerminal } from '../conversation/conversation-model';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import type { MobileTerminal } from './session-model';

export type SessionSegment = 'conversation' | 'terminal' | 'changes' | 'panels';

/**
 * Tab order in the Session header, left to right.
 */
export const SESSION_SEGMENTS: readonly SessionSegment[] = [
    'conversation',
    'terminal',
    'changes',
    'panels',
];

/**
 * Which way the tab strip moved, so the incoming panel can slide in from that side: `1` toward a later tab, `-1` toward
 * an earlier one, and `0` when nothing changed.
 */
export const sessionSegmentDirection = (from: SessionSegment, to: SessionSegment): -1 | 0 | 1 =>
    Math.sign(SESSION_SEGMENTS.indexOf(to) - SESSION_SEGMENTS.indexOf(from)) as -1 | 0 | 1;

/**
 * Side segments inspect the workspace rather than the Agent. On a wide tablet they open beside the last content
 * segment, so switching to one must remember which content segment to keep showing.
 */
export const isSideSessionSegment = (segment: SessionSegment): segment is 'changes' | 'panels' =>
    segment === 'changes' || segment === 'panels';

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
    remembered,
    status,
}: {
    hasAgentEndpoint: boolean;
    hasKnownAgent: boolean;
    remembered: SessionSegment | undefined;
    status: ConversationTimelineState['status'];
}): { fallback: boolean; hasConversation: boolean; segment: SessionSegment } => {
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
