import { MAX_MOBILE_FILE_BYTES } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { AttachmentStore } from './attachment-store';

/**
 * One file of any type waiting in a composer: a video, a recording, a PDF. Unlike an image it is not prepared; its
 * bytes upload as they are and the Agent reads it by its path on the computer.
 */
export interface FileAttachment {
    id: string;
    /**
     * The local copy the picker made, which Retry uploads again under a new ID.
     */
    uri: string;
    name: string;
    size: number;
    mimeType?: string;
    progress: number;
    state: 'uploading' | 'ready' | 'failed';
    /**
     * Where the uploaded file sits on the computer, once `ready`; a Chat message cites it by this path.
     */
    path?: string;
    error?: string;
    /**
     * When a `ready` file finished uploading, so the strip can stop offering one the Server has already deleted.
     */
    uploadedAt?: number;
}

export const fileAttachmentStore = new AttachmentStore<FileAttachment>();

/**
 * How long an uploaded file stays citable: the Server deletes an unsent upload after 60 minutes (`FILE_LIFETIME_MS` in
 * `apps/server/src/domains/mobile/file-store.ts`), less a margin for a send in flight.
 */
export const FILE_ATTACHMENT_REUSE_MS = 55 * 60_000;

/**
 * Turns a ready file the Server has likely deleted (it keeps an unsent upload for an hour) into a failed one, so Send
 * waits on the strip instead of citing a missing file. The phone still holds its copy, so Retry uploads it again.
 */
export const expireFileAttachments = (
    attachments: readonly FileAttachment[],
    now: number,
    t: Translate = translate,
): readonly FileAttachment[] => {
    const isExpired = (item: FileAttachment) =>
        item.state === 'ready' &&
        item.uploadedAt !== undefined &&
        now - item.uploadedAt > FILE_ATTACHMENT_REUSE_MS;
    return attachments.some(isExpired)
        ? attachments.map((item) =>
              isExpired(item)
                  ? {
                        id: item.id,
                        uri: item.uri,
                        name: item.name,
                        size: item.size,
                        ...(item.mimeType !== undefined && { mimeType: item.mimeType }),
                        progress: 0,
                        state: 'failed' as const,
                        error: t('sessions.file.expired'),
                    }
                  : item,
          )
        : attachments;
};

/**
 * Why Send waits on the files, or `null` when every one is uploaded. A failed file blocks too, because sending without
 * it would silently drop a file the user chose.
 */
export const fileAttachmentWaitReason = (
    attachments: readonly FileAttachment[],
    t: Translate = translate,
): string | null => {
    if (attachments.some((item) => item.state === 'failed')) return t('sessions.file.waitFailed');
    if (attachments.some((item) => item.state !== 'ready')) return t('sessions.file.waitUploading');
    return null;
};

/**
 * A byte count as a file manager shows it: `512 B`, `48 KB`, `12.4 MB`.
 */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'] as const;
    let value = bytes / 1_024;
    let unit = 0;
    while (value >= 1_024 && unit < units.length - 1) {
        value /= 1_024;
        unit += 1;
    }
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
};

/**
 * Why a picked file cannot be attached before any byte uploads, or `null` when it can.
 */
export const fileAttachmentRefusal = (
    file: { name: string; size: number },
    t: Translate = translate,
): string | null =>
    file.size > MAX_MOBILE_FILE_BYTES
        ? t('sessions.file.tooLarge', {
              name: file.name,
              max: formatFileSize(MAX_MOBILE_FILE_BYTES),
          })
        : null;

const MAX_NAME_BYTES = 255;

/**
 * A name the Server accepts (`isMobileFileName`) for a picked file: separators and control characters become `_`, a
 * missing or dot-only name falls back to the last segment of its local URI, and a long name keeps its extension.
 */
export const mobileUploadFileName = (name: string | null | undefined, uri: string): string => {
    const path = uri.split(/[?#]/u, 1)[0].replace(/\/+$/u, '');
    const segment = path.slice(path.lastIndexOf('/') + 1);
    let fallback = segment;
    try {
        fallback = decodeURIComponent(segment);
    } catch {
        // A stray `%` leaves the segment as it is.
    }
    const trimmed = name?.trim() ?? '';
    const raw = trimmed.length > 0 ? trimmed : fallback;
    // eslint-disable-next-line no-control-regex -- Control characters are exactly what a file name must not carry.
    let cleaned = raw.replaceAll(/[/\\\u{0}-\u{1F}\u{7F}]/gu, '_');
    if (['', '.', '..'].includes(cleaned)) cleaned = 'file';
    const encoder = new TextEncoder();
    if (encoder.encode(cleaned).length <= MAX_NAME_BYTES) return cleaned;
    const dot = cleaned.lastIndexOf('.');
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
    let stem = Array.from(cleaned.slice(0, cleaned.length - extension.length));
    while (stem.length > 0 && encoder.encode(stem.join('') + extension).length > MAX_NAME_BYTES)
        stem = stem.slice(0, -1);
    return stem.join('') + extension;
};

export type FileAttachmentKind = 'archive' | 'audio' | 'document' | 'image' | 'other' | 'video';

const EXTENSION_KINDS: Record<string, FileAttachmentKind> = {
    '7z': 'archive',
    'gz': 'archive',
    'rar': 'archive',
    'tar': 'archive',
    'zip': 'archive',
    'csv': 'document',
    'doc': 'document',
    'docx': 'document',
    'json': 'document',
    'key': 'document',
    'md': 'document',
    'numbers': 'document',
    'pages': 'document',
    'pdf': 'document',
    'ppt': 'document',
    'pptx': 'document',
    'rtf': 'document',
    'txt': 'document',
    'xls': 'document',
    'xlsx': 'document',
};

/**
 * Which glyph a file card shows, from its media type and, when that is missing or generic, its extension.
 */
export const fileAttachmentKind = (
    file: Pick<FileAttachment, 'mimeType' | 'name'>,
): FileAttachmentKind => {
    const type = file.mimeType?.split('/', 1)[0];
    if (type === 'video' || type === 'audio' || type === 'image') return type; // eslint-disable-line unicorn/prefer-includes-over-repeated-comparisons -- The comparisons narrow `type` to the kind.
    if (type === 'text' || file.mimeType === 'application/pdf') return 'document';
    const extension = file.name.includes('.')
        ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
        : '';
    return EXTENSION_KINDS[extension] ?? 'other';
};
