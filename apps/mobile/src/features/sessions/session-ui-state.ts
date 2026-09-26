import { shouldFallbackToTerminal } from '../conversation/conversation-model';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import type { MobileTerminal } from './session-model';

export type SessionSegment = 'conversation' | 'terminal' | 'changes' | 'panels';

/**
 * Side segments inspect the workspace rather than the Agent. On a wide tablet they open beside the last content
 * segment, so switching to one must remember which content segment to keep showing.
 */
export const isSideSessionSegment = (segment: SessionSegment): segment is 'changes' | 'panels' =>
    segment === 'changes' || segment === 'panels';

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
}): { fallback: boolean; segment: SessionSegment } => {
    const fallback =
        (remembered === undefined || remembered === 'conversation') &&
        shouldFallbackToTerminal(status);
    const available =
        status === 'available' ||
        (hasAgentEndpoint && !fallback) ||
        (hasKnownAgent && status === 'loading');
    return {
        fallback,
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
