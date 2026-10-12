import { notifyListeners } from '../../lib/notify-listeners';

/**
 * One image waiting in a composer. `preparing` covers the resize and compression before any byte is uploaded, so the
 * strip shows the picked picture at once instead of nothing for a second or two.
 */
export interface ImageAttachment {
    id: string;
    /**
     * What the thumbnail shows: the picked original while preparing, then the prepared JPEG.
     */
    uri: string;
    progress: number;
    state: 'preparing' | 'uploading' | 'ready' | 'failed';
    /**
     * The prepared image, kept only until it uploads: a ready image is never sent again, and a failed one needs it for
     * Retry.
     */
    base64?: string;
    /**
     * A Chat image's preview, uploaded after the image under its own ID.
     */
    thumbnail?: { id: string; base64?: string };
    error?: string;
    /**
     * When a `ready` image finished uploading, so the strip can stop offering one the Server has already deleted.
     */
    uploadedAt?: number;
}

/**
 * How long an uploaded image stays sendable: the Server deletes an unsent upload after 60 minutes (`IMAGE_LIFETIME_MS`
 * in `apps/server/src/domains/mobile/image-store.ts`), less a margin for a send in flight.
 */
export const IMAGE_ATTACHMENT_REUSE_MS = 55 * 60_000;

const EMPTY: readonly ImageAttachment[] = [];

/**
 * The composer's pending images live for the app session, keyed by pairing scope, composer surface, and Session, like
 * drafts do. Leaving the composer (a Project segment, the Session list) unmounts it, and an upload still running must
 * keep reporting progress to the strip that is shown again on return.
 */
export class ImageAttachmentStore {
    readonly #states = new Map<string, readonly ImageAttachment[]>();
    readonly #listeners = new Map<string, Set<() => void>>();
    readonly #cancelled = new Set<string>();

    get(key: string): readonly ImageAttachment[] {
        return this.#states.get(key) ?? EMPTY;
    }

    update(
        key: string,
        change: (current: readonly ImageAttachment[]) => readonly ImageAttachment[],
    ): void {
        const current = this.get(key);
        const next = change(current);
        if (next === current) return;
        if (next.length === 0) this.#states.delete(key);
        else this.#states.set(key, next);
        notifyListeners(this.#listeners.get(key) ?? [], undefined);
    }

    /**
     * Stops a running upload at its next chunk; the image is already gone from the strip.
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

export const imageAttachmentStore = new ImageAttachmentStore();

export const imageAttachmentKey = (
    scope: string | null,
    surface: 'chat' | 'terminal',
    sessionId: string,
): string => JSON.stringify([scope, surface, sessionId]);

export const patchImageAttachment = (
    attachments: readonly ImageAttachment[],
    id: string,
    patch: Partial<ImageAttachment>,
): readonly ImageAttachment[] =>
    attachments.some((item) => item.id === id)
        ? attachments.map((item) => (item.id === id ? { ...item, ...patch } : item))
        : attachments;

/**
 * Marks an upload finished and drops its bytes, which nothing reads again.
 */
export const completeImageAttachment = (
    attachments: readonly ImageAttachment[],
    id: string,
    now: number,
): readonly ImageAttachment[] =>
    attachments.some((item) => item.id === id)
        ? attachments.map((item) =>
              item.id === id
                  ? {
                        id: item.id,
                        uri: item.uri,
                        progress: 1,
                        state: 'ready' as const,
                        uploadedAt: now,
                        ...(item.thumbnail && { thumbnail: { id: item.thumbnail.id } }),
                    }
                  : item,
          )
        : attachments;

/**
 * Turns a ready image the Server has likely deleted into a failed one, so Send waits on the strip instead of
 * referencing a missing upload. Its bytes are gone, so its error asks for the image again.
 */
export const expireImageAttachments = (
    attachments: readonly ImageAttachment[],
    now: number,
): readonly ImageAttachment[] =>
    attachments.some(
        (item) =>
            item.state === 'ready' &&
            item.uploadedAt !== undefined &&
            now - item.uploadedAt > IMAGE_ATTACHMENT_REUSE_MS,
    )
        ? attachments.map((item) =>
              item.state === 'ready' &&
              item.uploadedAt !== undefined &&
              now - item.uploadedAt > IMAGE_ATTACHMENT_REUSE_MS
                  ? {
                        id: item.id,
                        uri: item.uri,
                        progress: 0,
                        state: 'failed' as const,
                        error: 'This image expired on your computer. Remove it and attach it again.',
                    }
                  : item,
          )
        : attachments;

export const removeImageAttachment = (
    attachments: readonly ImageAttachment[],
    id: string,
): readonly ImageAttachment[] =>
    attachments.some((item) => item.id === id)
        ? attachments.filter((item) => item.id !== id)
        : attachments;

/**
 * Why Send waits on the strip, or `null` when every image is ready. A failed image blocks too, because sending without
 * it would silently drop a picture the user chose.
 */
export const imageAttachmentWaitReason = (
    attachments: readonly ImageAttachment[],
): string | null => {
    if (attachments.some((item) => item.state === 'failed'))
        return "An image didn't upload. Tap it to retry or remove it.";
    if (attachments.some((item) => item.state !== 'ready')) return 'Waiting for images to upload…';
    return null;
};

/**
 * The screen reader name of one strip thumbnail: its place in the strip, then its state.
 */
export const imageAttachmentAccessibilityLabel = (
    attachment: Pick<ImageAttachment, 'progress' | 'state'>,
    index: number,
    count: number,
): string => {
    const position = `Image ${index + 1} of ${count}`;
    switch (attachment.state) {
        case 'preparing':
            return `${position}, preparing`;
        case 'uploading':
            return `${position}, uploading ${Math.round(attachment.progress * 100)}%`;
        case 'failed':
            return `${position}, upload failed`;
        case 'ready':
            return position;
    }
};
