import { create } from 'zustand';

interface WorkbenchRootCandidate {
    candidateId: string;
    sessionId: string;
}

interface WorkbenchRootPromptState {
    candidates: Record<string, WorkbenchRootCandidate>;
    dismiss(sessionId: string): void;
    show(candidate: WorkbenchRootCandidate): void;
}

/** Keeps one content-free candidate per Session until the user handles it. */
export const useWorkbenchRootPromptStore = create<WorkbenchRootPromptState>((set) => ({
    candidates: {},
    dismiss: (sessionId) =>
        set((state) => {
            if (!state.candidates[sessionId]) return state;
            const candidates = { ...state.candidates };
            delete candidates[sessionId];
            return { candidates };
        }),
    show: (candidate) =>
        set((state) => ({
            candidates: { ...state.candidates, [candidate.sessionId]: candidate },
        })),
}));

export function showWorkbenchRootCandidate(candidate: WorkbenchRootCandidate): void {
    useWorkbenchRootPromptStore.getState().show(candidate);
}

export function dismissWorkbenchRootCandidate(sessionId: string): void {
    useWorkbenchRootPromptStore.getState().dismiss(sessionId);
}
