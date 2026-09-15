import { omit } from 'es-toolkit';

import { createStore } from '../../lib/store';

export interface WorkbenchRootCandidate {
    candidateId: string;
    sessionId: string;
    rootPath: string;
}

interface WorkbenchRootPromptState {
    candidates: Record<string, WorkbenchRootCandidate>;
    dismiss(sessionId: string): void;
    show(candidate: WorkbenchRootCandidate): void;
}

/**
 * Keeps one candidate and its display-only destination per Session until the user handles it.
 */
export const useWorkbenchRootPromptStore = createStore<WorkbenchRootPromptState>(
    'workbench-root-prompt',
    (set) => ({
        candidates: {},
        dismiss: (sessionId) =>
            set((state) => {
                if (!Object.hasOwn(state.candidates, sessionId)) return state;
                return { candidates: omit(state.candidates, [sessionId]) };
            }),
        show: (candidate) =>
            set((state) => ({
                candidates: { ...state.candidates, [candidate.sessionId]: candidate },
            })),
    }),
);

export function showWorkbenchRootCandidate(candidate: WorkbenchRootCandidate): void {
    useWorkbenchRootPromptStore.getState().show(candidate);
}

export function dismissWorkbenchRootCandidate(sessionId: string): void {
    useWorkbenchRootPromptStore.getState().dismiss(sessionId);
}
