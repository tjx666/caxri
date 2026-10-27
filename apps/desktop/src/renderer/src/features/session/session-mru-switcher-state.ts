import type { SessionRecord } from '@caxri/protocol';

import type { SessionMruShortcutInvocation } from '../../commands/registry';
import { createStore } from '../../lib/store';

const SWITCHER_REVEAL_DELAY_MS = 120;

export function sessionMruCandidates(
    sessions: readonly SessionRecord[],
    selectedSessionId: string | undefined,
): SessionRecord[] {
    return sessions
        .filter((session) => session.archivedAt === undefined && session.id !== selectedSessionId)
        .toSorted(
            (left, right) =>
                right.lastVisitedAt - left.lastVisitedAt ||
                right.createdAt - left.createdAt ||
                left.id.localeCompare(right.id),
        );
}

export function resolveSessionMruView(
    candidateIds: readonly string[],
    sessions: readonly SessionRecord[],
    requestedSelectedIndex: number,
): { candidates: SessionRecord[]; selected?: SessionRecord; selectedIndex: number } {
    const candidates = candidateIds.flatMap((id) => {
        const session = sessions.find((item) => item.id === id);
        return session && session.archivedAt === undefined ? [session] : [];
    });
    const selectedIndex = Math.min(requestedSelectedIndex, candidates.length - 1);
    return { candidates, selected: candidates.at(selectedIndex), selectedIndex };
}

export interface PendingSessionMruSelection {
    currentSessionId: string;
    previousSessionId: string;
}

export function resolveSessionMruNavigation(
    sessions: readonly SessionRecord[],
    selectedSessionId: string | undefined,
    pendingSelection?: PendingSessionMruSelection,
): {
    candidateIds: string[];
    pendingSelection?: PendingSessionMruSelection;
    selectedSessionId: string | undefined;
} {
    const pending =
        pendingSelection?.currentSessionId === selectedSessionId ? undefined : pendingSelection;
    const effectiveSelectedSessionId = pending?.currentSessionId ?? selectedSessionId;
    const candidateIds = sessionMruCandidates(sessions, effectiveSelectedSessionId).map(
        (session) => session.id,
    );
    if (pending) {
        const previousIndex = candidateIds.indexOf(pending.previousSessionId);
        if (previousIndex > 0) candidateIds.unshift(...candidateIds.splice(previousIndex, 1));
    }
    return {
        candidateIds,
        ...(pending && { pendingSelection: pending }),
        selectedSessionId: effectiveSelectedSessionId,
    };
}

interface SessionMruSwitcherState {
    candidateIds: string[];
    heldModifiers: SessionMruShortcutInvocation['heldModifiers'];
    isOpen: boolean;
    isVisible: boolean;
    selectedIndex: number;
    triggerCode?: string;
    beginOrCycle(
        candidateIds: string[],
        invocation?: SessionMruShortcutInvocation,
    ): string | undefined;
    cancel(): void;
    commit(availableCandidateIds?: readonly string[]): string | undefined;
    cycle(delta: 1 | -1): void;
    select(index: number): void;
}

const closedState = {
    candidateIds: [] as string[],
    heldModifiers: [] as SessionMruShortcutInvocation['heldModifiers'],
    isOpen: false,
    isVisible: false,
    selectedIndex: 0,
    triggerCode: undefined,
};

export const useSessionMruSwitcherStore = createStore<SessionMruSwitcherState>(
    'session-mru-switcher',
    (set, get) => {
        let revealTimer: ReturnType<typeof setTimeout> | undefined;
        const clearRevealTimer = (): void => {
            if (revealTimer !== undefined) clearTimeout(revealTimer);
            revealTimer = undefined;
        };

        return {
            ...closedState,
            beginOrCycle: (candidateIds, invocation) => {
                if (get().isOpen) {
                    get().cycle(invocation?.direction ?? 1);
                    return;
                }
                if (candidateIds.length === 0) return;
                if (!invocation) return candidateIds[0];
                const selectedIndex = invocation.direction === -1 ? candidateIds.length - 1 : 0;
                if (invocation.heldModifiers.length === 0) return candidateIds[selectedIndex];
                clearRevealTimer();
                set({
                    candidateIds,
                    heldModifiers: invocation.heldModifiers,
                    isOpen: true,
                    isVisible: false,
                    selectedIndex,
                    triggerCode: invocation.triggerCode,
                });
                revealTimer = setTimeout(() => {
                    revealTimer = undefined;
                    if (get().isOpen) set({ isVisible: true });
                }, SWITCHER_REVEAL_DELAY_MS);
                return;
            },
            cancel: () => {
                clearRevealTimer();
                set(closedState);
            },
            commit: (availableCandidateIds) => {
                const state = get();
                const candidates = availableCandidateIds ?? state.candidateIds;
                const selectedIndex = Math.min(state.selectedIndex, candidates.length - 1);
                const sessionId = state.isOpen ? candidates.at(selectedIndex) : undefined;
                clearRevealTimer();
                set(closedState);
                return sessionId;
            },
            cycle: (delta) =>
                set((state) => {
                    if (!state.isOpen || state.candidateIds.length === 0) return state;
                    return {
                        selectedIndex:
                            (state.selectedIndex + delta + state.candidateIds.length) %
                            state.candidateIds.length,
                    };
                }),
            /**
             * Pointer-driven highlight. The index addresses the rendered candidate list, which `resolveSessionMruView`
             * derives from `candidateIds` with the same archived filter `commit` applies, so a hovered row commits to
             * the Session the user actually pointed at. Out-of-range indexes are ignored rather than clamped: a stale
             * row under the cursor must never silently retarget the keyboard selection.
             */
            select: (index) =>
                set((state) => {
                    if (!state.isOpen || index < 0 || index >= state.candidateIds.length)
                        return state;
                    return { selectedIndex: index };
                }),
        };
    },
);
