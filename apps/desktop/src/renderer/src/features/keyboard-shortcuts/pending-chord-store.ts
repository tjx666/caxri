import { createStore } from '../../lib/store';

/**
 * How long an armed chord waits for its second keystroke. Matches VS Code's chord timeout, long enough to read the hint
 * and short enough that a forgotten `Cmd+K` does not swallow a keystroke minutes later.
 */
export const PENDING_CHORD_TIMEOUT_MS = 5000;

interface PendingChordState {
    /**
     * The leading chord Caxri is waiting on, in the stored form (`cmd+k`), or undefined when no sequence is armed. A
     * sequence released to the editor is never published: Monaco owns its own chord feedback.
     */
    leadingChord?: string;
}

export const usePendingChordStore = createStore<PendingChordState>('pendingChord', () => ({}));

const timer: { expiry?: ReturnType<typeof setTimeout> } = {};

/**
 * Mirrors the dispatcher's pending chord into the store the hint reads, and arms the timeout that ends the sequence.
 * `expire` clears the dispatcher's own state, so the hint and the swallowed second keystroke never disagree about
 * whether a chord is still armed.
 */
export function publishPendingChord(leadingChord: string | undefined, expire: () => void): void {
    if (timer.expiry !== undefined) clearTimeout(timer.expiry);
    timer.expiry = undefined;
    if (usePendingChordStore.getState().leadingChord !== leadingChord)
        usePendingChordStore.setState({ leadingChord });
    if (leadingChord === undefined) return;
    timer.expiry = setTimeout(() => {
        timer.expiry = undefined;
        expire();
        usePendingChordStore.setState({ leadingChord: undefined });
    }, PENDING_CHORD_TIMEOUT_MS);
}
