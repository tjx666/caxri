import { notifyListeners } from '../../lib/notify-listeners';

/**
 * The composer's pending attachments of one kind live for the app session, keyed by pairing scope, composer surface,
 * and Session, like drafts do. Leaving the composer (a Project segment, the Session list) unmounts it, and an upload
 * still running must keep reporting progress to the strip that is shown again on return.
 */
export class AttachmentStore<T extends { id: string }> {
    readonly #states = new Map<string, readonly T[]>();
    readonly #listeners = new Map<string, Set<() => void>>();
    readonly #cancelled = new Set<string>();
    readonly #empty: readonly T[] = [];

    get(key: string): readonly T[] {
        return this.#states.get(key) ?? this.#empty;
    }

    update(key: string, change: (current: readonly T[]) => readonly T[]): void {
        const current = this.get(key);
        const next = change(current);
        if (next === current) return;
        if (next.length === 0) this.#states.delete(key);
        else this.#states.set(key, next);
        notifyListeners(this.#listeners.get(key) ?? [], undefined);
    }

    /**
     * Stops a running upload at its next chunk; the attachment is already gone from the strip.
     */
    cancel(id: string): void {
        this.#cancelled.add(id);
    }

    isCancelled(id: string): boolean {
        return this.#cancelled.has(id);
    }

    subscribe(key: string, listener: () => void): () => void {
        const listeners = this.#listeners.get(key) ?? new Set<() => void>();
        listeners.add(listener);
        this.#listeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.#listeners.delete(key);
        };
    }
}

export const attachmentKey = (
    scope: string | null,
    surface: 'chat' | 'terminal',
    sessionId: string,
): string => JSON.stringify([scope, surface, sessionId]);

export const patchAttachment = <T extends { id: string }>(
    attachments: readonly T[],
    id: string,
    patch: Partial<T>,
): readonly T[] =>
    attachments.some((item) => item.id === id)
        ? attachments.map((item) => (item.id === id ? { ...item, ...patch } : item))
        : attachments;

export const removeAttachment = <T extends { id: string }>(
    attachments: readonly T[],
    id: string,
): readonly T[] =>
    attachments.some((item) => item.id === id)
        ? attachments.filter((item) => item.id !== id)
        : attachments;

/**
 * The strip after a failed send returns its attachments: ahead of any attached since, and one still attached is not
 * added twice. Returns the same strip when nothing comes back.
 */
export const attachmentsWithReturned = <T extends { id: string }>(
    current: readonly T[],
    returned: readonly T[],
): readonly T[] => {
    const currentIds = new Set(current.map((item) => item.id));
    const missing = returned.filter((item) => !currentIds.has(item.id));
    return missing.length === 0 ? current : [...missing, ...current];
};
