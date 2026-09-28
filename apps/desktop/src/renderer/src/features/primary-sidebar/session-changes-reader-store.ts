import { createStore } from '../../lib/store';

interface SessionChangesReaderState {
    /**
     * The one open Session card allowed to read another Session's change count. The latest card to open wins.
     */
    readerId?: string;
    claim(readerId: string): void;
    release(readerId: string): void;
}

/**
 * Bounds another Session's `git.overview` reads to one card at a time (issue #859).
 *
 * Each Session card owns its own open state, and hover and keyboard focus can leave two cards open together — focus
 * opens one, the pointer another — so gating the read on a card's own open state alone does not bound the fan-out. A
 * card that loses the claim while still open keeps showing what it already read; it just stops asking.
 */
export const useSessionChangesReaderStore = createStore<SessionChangesReaderState>(
    'session-changes-reader',
    (set) => ({
        readerId: undefined,
        claim: (readerId) => set((state) => (state.readerId === readerId ? state : { readerId })),
        release: (readerId) =>
            set((state) => (state.readerId === readerId ? { readerId: undefined } : state)),
    }),
);

export function claimSessionChangesReader(readerId: string): void {
    useSessionChangesReaderStore.getState().claim(readerId);
}

export function releaseSessionChangesReader(readerId: string): void {
    useSessionChangesReaderStore.getState().release(readerId);
}
