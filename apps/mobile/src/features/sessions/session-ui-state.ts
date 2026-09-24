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
