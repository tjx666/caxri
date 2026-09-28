import { notifyListeners } from '@caxri/utils';

/**
 * Carries the source editor's topmost visible line to any preview showing the same document.
 *
 * A module-level map rather than a store: the value changes on every scroll frame, and routing it through React state
 * would re-render the preview tree for a position only one effect reads.
 */
type ScrollListener = (topLine: number) => void;

const listeners = new Map<string, Set<ScrollListener>>();
const latest = new Map<string, number>();

export function publishSourceScroll(path: string, topLine: number): void {
    const subscribers = listeners.get(path);
    // Every open editor publishes on every scroll frame; a file nobody is previewing must not accumulate a map entry.
    if (!subscribers) return;
    if (latest.get(path) === topLine) return;
    latest.set(path, topLine);
    // Isolates each preview subscriber so one throwing preview pane cannot stop this document's other previews from
    // observing the scroll position; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
    notifyListeners(subscribers, topLine, (error) =>
        console.error('preview.sourceScroll listener failed', error),
    );
}

export function subscribeSourceScroll(path: string, listener: ScrollListener): () => void {
    const existing = listeners.get(path) ?? new Set<ScrollListener>();
    existing.add(listener);
    listeners.set(path, existing);
    return () => {
        existing.delete(listener);
        if (existing.size === 0) {
            listeners.delete(path);
            latest.delete(path);
        }
    };
}

export function lastSourceScroll(path: string): number | undefined {
    return latest.get(path);
}
