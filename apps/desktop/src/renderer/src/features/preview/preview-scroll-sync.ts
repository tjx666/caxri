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
    if (latest.get(path) === topLine) return;
    latest.set(path, topLine);
    const subscribers = listeners.get(path);
    if (!subscribers) return;
    for (const listener of subscribers) listener(topLine);
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
