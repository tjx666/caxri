import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
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
    /**
     * The prepared image's base64 length, kept after its bytes are dropped so a Chat message's images can be held to
     * the protocol's combined limit (`MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH`).
     */
    base64Length?: number;
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
                        ...(item.base64Length !== undefined && { base64Length: item.base64Length }),
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
    t: Translate = translate,
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
                        error: t('sessions.image.expired'),
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
 * The strip after a failed send returns its images: ahead of any attached since, and one still attached is not added
 * twice. Returns the same strip when nothing comes back.
 */
export const imageAttachmentsWithReturned = (
    current: readonly ImageAttachment[],
    returned: readonly ImageAttachment[],
): readonly ImageAttachment[] => {
    const currentIds = new Set(current.map((item) => item.id));
    const missing = returned.filter((item) => !currentIds.has(item.id));
    return missing.length === 0 ? current : [...missing, ...current];
};

/**
 * Why Send waits on the strip, or `null` when every image is ready. A failed image blocks too, because sending without
 * it would silently drop a picture the user chose.
 */
export const imageAttachmentWaitReason = (
    attachments: readonly ImageAttachment[],
    t: Translate = translate,
): string | null => {
    if (attachments.some((item) => item.state === 'failed')) return t('sessions.image.waitFailed');
    if (attachments.some((item) => item.state !== 'ready'))
        return t('sessions.image.waitUploading');
    return null;
};

/**
 * The screen reader name of one strip thumbnail: its place in the strip, then its state.
 */
export const imageAttachmentAccessibilityLabel = (
    attachment: Pick<ImageAttachment, 'progress' | 'state'>,
    index: number,
    count: number,
    t: Translate = translate,
): string => {
    const position = t('sessions.image.position', { count, index: index + 1 });
    switch (attachment.state) {
        case 'preparing':
            return t('sessions.image.positionPreparing', { position });
        case 'uploading':
            return t('sessions.image.positionUploading', {
                percent: Math.round(attachment.progress * 100),
                position,
            });
        case 'failed':
            return t('sessions.image.positionFailed', { position });
        case 'ready':
            return position;
    }
};

/**
 * The combined base64 length of the strip's prepared images, leaving out `exceptId` (the image being judged).
 */
export const imageAttachmentsBase64Length = (
    attachments: ReadonlyArray<Pick<ImageAttachment, 'base64Length' | 'id'>>,
    exceptId?: string,
): number =>
    attachments.reduce(
        (total, item) => (item.id === exceptId ? total : total + (item.base64Length ?? 0)),
        0,
    );

/**
 * Past this share of the combined limit the composer says how much of it the images use, so the limit does not come as
 * a surprise on the next image.
 */
const IMAGE_BUDGET_NOTE_RATIO = 0.75;

const BASE64_BYTES_PER_CHARACTER = 3 / 4;

const formatMegabytes = (bytes: number): string => {
    const megabytes = bytes / 1_024 / 1_024;
    return Number.isSafeInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1);
};

/**
 * The composer's note on a Chat message's images once they use most of the combined limit (`Images use 16.2 of 20
 * MB.`), or `null` below it.
 */
export const imageAttachmentBudgetNote = (
    attachments: ReadonlyArray<Pick<ImageAttachment, 'base64Length' | 'id'>>,
    maxBase64Length: number,
    maxBytes: number,
    t: Translate = translate,
): string | null => {
    const used = imageAttachmentsBase64Length(attachments);
    if (used < maxBase64Length * IMAGE_BUDGET_NOTE_RATIO) return null;
    const usedBytes = Math.min(used * BASE64_BYTES_PER_CHARACTER, maxBytes);
    return t('sessions.image.budget', {
        max: formatMegabytes(maxBytes),
        used: formatMegabytes(usedBytes),
    });
};
