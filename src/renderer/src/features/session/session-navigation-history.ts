import { create } from 'zustand';

/**
 * Upper bound on remembered visits. VS Code caps its editor navigation history for the same reason: an unbounded stack
 * turns a long-running window into a list nobody can walk back through anyway.
 */
const HISTORY_LIMIT = 50;

export type SessionNavigationDirection = 'back' | 'forward';

export interface SessionNavigationHistorySnapshot {
    /**
     * Sessions visited before {@link current}, oldest first; the last entry is the next `back` target.
     */
    back: string[];
    /**
     * Sessions stepped back from, in the order `forward` will replay them.
     */
    forward: string[];
    current?: string;
}

const EMPTY_SNAPSHOT: SessionNavigationHistorySnapshot = {
    back: [],
    current: undefined,
    forward: [],
};

function pushCapped(stack: readonly string[], sessionId: string): string[] {
    const next = [...stack, sessionId];
    return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * Drops entries that repeat {@link SessionNavigationHistorySnapshot.current} at the top of a stack.
 *
 * A repeat deeper in a stack is real history (`A → B → A` genuinely visited A twice), but a repeat at the top is a dead
 * step: navigating to it would re-select the Session already on screen, leave the stack unchanged, and keep the button
 * enabled forever. Pruning an archived Session out of the middle is what creates them.
 */
function dropRedundantTop(stack: readonly string[], current: string | undefined): string[] {
    let end = stack.length;
    while (end > 0 && stack[end - 1] === current) end--;
    return end === stack.length ? [...stack] : stack.slice(0, end);
}

/**
 * Folds an ordinary Session selection into the history: the outgoing Session becomes the next `back` target and the
 * forward history is truncated, exactly like following a link in a browser.
 *
 * History navigation does not go through here — {@link applySessionNavigation} moves the stacks at request time so a
 * second navigation issued before the Runtime confirms the first still computes from the state the user can see.
 */
export function recordSessionVisit(
    snapshot: SessionNavigationHistorySnapshot,
    next: string | undefined,
): SessionNavigationHistorySnapshot {
    const { back, current, forward } = snapshot;
    if (next === current) return snapshot;
    if (next === undefined) return { back, current: undefined, forward };
    if (current === undefined) return { back, current: next, forward };
    return { back: pushCapped(back, current), current: next, forward: [] };
}

/**
 * Moves the stacks one step in `direction`, returning the snapshot unchanged when that direction has no target.
 */
export function applySessionNavigation(
    snapshot: SessionNavigationHistorySnapshot,
    direction: SessionNavigationDirection,
): SessionNavigationHistorySnapshot {
    const { back, current, forward } = snapshot;
    const target = sessionNavigationTarget(snapshot, direction);
    if (target === undefined || current === undefined) return snapshot;
    return direction === 'back'
        ? { back: back.slice(0, -1), current: target, forward: pushCapped(forward, current) }
        : { back: pushCapped(back, current), current: target, forward: forward.slice(0, -1) };
}

/**
 * Drops Sessions that no longer exist or were archived. Without this, `Go Back` would keep offering a deleted Session
 * and quietly do nothing when it is chosen.
 */
export function pruneSessionHistory(
    snapshot: SessionNavigationHistorySnapshot,
    activeSessionIds: readonly string[],
): SessionNavigationHistorySnapshot {
    const active = new Set(activeSessionIds);
    const isActive = (sessionId: string): boolean => active.has(sessionId);
    const back = dropRedundantTop(snapshot.back.filter(isActive), snapshot.current);
    const forward = dropRedundantTop(snapshot.forward.filter(isActive), snapshot.current);
    if (back.length === snapshot.back.length && forward.length === snapshot.forward.length) {
        return snapshot;
    }
    return { back, current: snapshot.current, forward };
}

export function sessionNavigationTarget(
    snapshot: SessionNavigationHistorySnapshot,
    direction: SessionNavigationDirection,
): string | undefined {
    return direction === 'back' ? snapshot.back.at(-1) : snapshot.forward.at(-1);
}

interface SessionNavigationHistoryState extends SessionNavigationHistorySnapshot {
    /**
     * Targets of navigations already applied to the stacks, oldest first, still waiting for the Runtime to report them
     * as the selected Session.
     *
     * The queue exists because those confirmations arrive late and in request order: pressing Back twice in quick
     * succession lands the first snapshot only after the second step was applied, and treating it as a fresh selection
     * would push the Session onto `back` and wipe `forward`. Matching each confirmation against its own target — not
     * merely against `current` — is what makes overlapping navigations safe.
     */
    pendingTargets: string[];
    /**
     * Records the Session the workbench actually shows. Every selection path (Sidebar, palette, MRU switcher, Session
     * creation, a Runtime-driven switch) funnels through the observed selection rather than through each call site, so
     * no navigation source can forget to write history. Re-observing the same Session is a no-op, which also makes the
     * React StrictMode double effect harmless.
     */
    observe(sessionId?: string): void;
    prune(activeSessionIds: readonly string[]): void;
    /**
     * Claims the next target in `direction`, moving the stacks immediately and returning the Session to select.
     *
     * The move is optimistic on purpose: the Runtime's snapshot refresh is asynchronous, so a second navigation issued
     * before it lands must compute from the state the first one produced. Pressing Back then Forward that fast is then
     * exactly a no-op, instead of both steps reading the same stale stacks and stranding the history.
     */
    request(direction: SessionNavigationDirection): string | undefined;
    /**
     * Rolls back to `snapshot` when the selection this store optimistically applied never took effect. Nothing is
     * restored if another navigation or selection has moved on since, because that newer state is the truthful one.
     */
    restore(snapshot: SessionNavigationHistorySnapshot, appliedSessionId: string): void;
    reset(): void;
}

export const useSessionNavigationHistoryStore = create<SessionNavigationHistoryState>(
    (set, get) => ({
        ...EMPTY_SNAPSHOT,
        pendingTargets: [],
        observe: (sessionId) =>
            set((state) => {
                const [oldest, ...rest] = state.pendingTargets;
                if (sessionId === undefined || state.pendingTargets.length === 0) {
                    return recordSessionVisit(state, sessionId);
                }
                // The confirmation this store is waiting for: the stacks already moved, so only the queue advances.
                if (sessionId === oldest) return { pendingTargets: rest };
                // Any other Session means an ordinary selection overtook the navigation, and it owns the history now.
                return { ...recordSessionVisit(state, sessionId), pendingTargets: [] };
            }),
        prune: (activeSessionIds) =>
            set((state) => {
                const active = new Set(activeSessionIds);
                return {
                    ...pruneSessionHistory(state, activeSessionIds),
                    pendingTargets: state.pendingTargets.filter((target) => active.has(target)),
                };
            }),
        request: (direction) => {
            const state = get();
            const target = sessionNavigationTarget(state, direction);
            if (target === undefined) return;
            set({
                ...applySessionNavigation(state, direction),
                pendingTargets: [...state.pendingTargets, target],
            });
            return target;
        },
        restore: (snapshot, appliedSessionId) =>
            set((state) => {
                const index = state.pendingTargets.indexOf(appliedSessionId);
                const pendingTargets =
                    index === -1 ? state.pendingTargets : state.pendingTargets.toSpliced(index, 1);
                return state.current === appliedSessionId
                    ? { ...snapshot, pendingTargets }
                    : { pendingTargets };
            }),
        reset: () => set({ ...EMPTY_SNAPSHOT, pendingTargets: [] }),
    }),
);

/**
 * The plain history value behind the store, safe to hold across an await as a rollback target.
 */
export function sessionNavigationSnapshot(): SessionNavigationHistorySnapshot {
    const { back, current, forward } = useSessionNavigationHistoryStore.getState();
    return { back: [...back], current, forward: [...forward] };
}
