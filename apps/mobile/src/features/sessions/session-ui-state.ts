import { shouldFallbackToTerminal } from '../conversation/conversation-model';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';

export type SessionSegment = 'conversation' | 'terminal' | 'changes';

export interface HostSessionUiState {
    draftBySession: Record<string, string>;
    projectId: string | null;
    segmentBySession: Record<string, SessionSegment>;
}

export const emptyHostSessionUiState = (): HostSessionUiState => ({
    draftBySession: {},
    projectId: null,
    segmentBySession: {},
});

export const preferredSessionSegment = (
    remembered: SessionSegment | undefined,
    isConversationAvailable: boolean,
): SessionSegment => remembered ?? (isConversationAvailable ? 'conversation' : 'terminal');

export const resolveSessionConversationSegment = ({
    hasAgentEndpoint,
    remembered,
    status,
}: {
    hasAgentEndpoint: boolean;
    remembered: SessionSegment | undefined;
    status: ConversationTimelineState['status'];
}): { fallback: boolean; segment: SessionSegment } => {
    const fallback =
        (remembered === undefined || remembered === 'conversation') &&
        shouldFallbackToTerminal(status);
    const available = status === 'available' || (hasAgentEndpoint && !fallback);
    return {
        fallback,
        segment: fallback ? 'terminal' : preferredSessionSegment(remembered, available),
    };
};

export const rememberSessionSegment = (
    state: HostSessionUiState,
    sessionId: string,
    segment: SessionSegment,
): HostSessionUiState => ({
    ...state,
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
