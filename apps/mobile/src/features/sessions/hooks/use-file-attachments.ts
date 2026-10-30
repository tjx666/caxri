import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { encodeHex } from '@caxri/mobile-transport';
import { MAX_MOBILE_FILE_ATTACHMENTS, MOBILE_FILE_CHUNK_BYTES } from '@caxri/protocol';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, FileMode } from 'expo-file-system';

import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage, MobileLocalizedError } from '../../connection/mobile-error-message';
import {
    attachmentKey,
    attachmentsWithReturned,
    patchAttachment,
    removeAttachment,
} from '../attachment-store';
import type { FileAttachment } from '../file-attachment-store';
import {
    expireFileAttachments,
    fileAttachmentRefusal,
    fileAttachmentStore,
    fileAttachmentWaitReason,
    mobileUploadFileName,
} from '../file-attachment-store';
import { encodeBase64, uploadFileChunks } from '../file-upload';

/**
 * A file a picker returned, before it is attached. `size` is absent when the picker did not report it.
 */
export interface PickedFile {
    uri: string;
    name?: string | null;
    size?: number | null;
    mimeType?: string | null;
}

const newAttachmentId = (): string => `file_${encodeHex(Crypto.getRandomBytes(16))}`;

/**
 * The pending files of one composer: videos, recordings, documents, anything that is not sent as an inline image. Like
 * images they live in a store rather than component state, so leaving the composer keeps them and an upload started
 * before leaving still finishes.
 */
export const useFileAttachments = (
    sessionId: string,
    { surface = 'terminal' }: { surface?: 'chat' | 'terminal' } = {},
) => {
    const { connectionScopeKey, request } = useMobileClient();
    const { t } = useTranslation();
    /**
     * Why the last pick failed or which files it left out, for the composer's status line.
     */
    const [attachError, setAttachError] = useState<string | null>(null);
    const [failedId, setFailedId] = useState<string>();
    const key = attachmentKey(connectionScopeKey, surface, sessionId);
    const subscribe = useCallback(
        (listener: () => void) => fileAttachmentStore.subscribe(key, listener),
        [key],
    );
    const snapshot = useCallback(() => fileAttachmentStore.get(key), [key]);
    const attachments = useSyncExternalStore(subscribe, snapshot, snapshot);
    const update = (change: (current: readonly FileAttachment[]) => readonly FileAttachment[]) =>
        fileAttachmentStore.update(key, change);
    // Pending files outlive the composer; one the Server has deleted since must not look ready on return.
    useEffect(() => {
        fileAttachmentStore.update(key, (current) => expireFileAttachments(current, Date.now(), t));
    }, [key, t]);

    const upload = async (item: FileAttachment) => {
        let handle: ReturnType<File['open']> | undefined;
        try {
            try {
                handle = new File(item.uri).open(FileMode.ReadOnly);
            } catch {
                throw new MobileLocalizedError(t('sessions.file.unreadable'));
            }
            const opened = handle;
            const path = await uploadFileChunks({
                size: item.size,
                isCancelled: () => fileAttachmentStore.isCancelled(item.id),
                onProgress: (progress) =>
                    update((current) => patchAttachment(current, item.id, { progress })),
                // Synchronous, so two chunks in flight never move the shared offset under each other.
                readChunk: (index) => {
                    opened.offset = index * MOBILE_FILE_CHUNK_BYTES;
                    return encodeBase64(opened.readBytesSync(MOBILE_FILE_CHUNK_BYTES));
                },
                sendChunk: async (chunkIndex, chunk) =>
                    request('mobile.file.upload', {
                        sessionId,
                        attachmentId: item.id,
                        name: item.name,
                        size: item.size,
                        chunkIndex,
                        chunk,
                    }),
            });
            if (path === undefined) return;
            update((current) =>
                patchAttachment(current, item.id, {
                    path,
                    progress: 1,
                    state: 'ready',
                    uploadedAt: Date.now(),
                }),
            );
        } catch (error) {
            update((current) =>
                patchAttachment(current, item.id, {
                    state: 'failed',
                    error: mobileErrorMessage(error, t('sessions.image.uploadFailed'), t),
                }),
            );
        } finally {
            handle?.close();
        }
    };

    const remaining = () => MAX_MOBILE_FILE_ATTACHMENTS - fileAttachmentStore.get(key).length;

    /**
     * Attaches picked files and uploads them one after another; a file past the size limit, or past the per-message
     * count, is left out and named on the status line.
     */
    const add = async (picked: readonly PickedFile[]) => {
        setAttachError(null);
        const refusals: string[] = [];
        const accepted: FileAttachment[] = [];
        for (const file of picked) {
            const name = mobileUploadFileName(file.name, file.uri);
            let size = file.size ?? undefined;
            if (size === undefined) {
                try {
                    size = new File(file.uri).size;
                } catch {
                    refusals.push(`${name}: ${t('sessions.file.unreadable')}`);
                    continue;
                }
            }
            const refusal = fileAttachmentRefusal({ name, size }, t);
            if (refusal) {
                refusals.push(refusal);
                continue;
            }
            if (accepted.length >= remaining()) {
                refusals.push(t('sessions.file.limit', { count: MAX_MOBILE_FILE_ATTACHMENTS }));
                break;
            }
            accepted.push({
                id: newAttachmentId(),
                uri: file.uri,
                name,
                size,
                ...(file.mimeType && { mimeType: file.mimeType }),
                progress: 0,
                state: 'uploading',
            });
        }
        if (refusals.length > 0)
            setAttachError(`${t('sessions.file.attachFailedTitle')}. ${refusals.join(' ')}`);
        if (accepted.length === 0) return;
        update((current) => [...current, ...accepted]);
        for (const item of accepted) {
            // Files upload one after another so the first one is ready soonest.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- see above
            await upload(item); // eslint-disable-line no-await-in-loop -- see above
        }
    };

    /**
     * Opens the system document picker for files of any type.
     */
    const pick = async () => {
        if (remaining() <= 0) {
            setAttachError(t('sessions.file.limit', { count: MAX_MOBILE_FILE_ATTACHMENTS }));
            return;
        }
        setAttachError(null);
        try {
            const result = await DocumentPicker.getDocumentAsync({
                copyToCacheDirectory: true,
                multiple: true,
                type: '*/*',
            });
            if (result.canceled) return;
            await add(result.assets);
        } catch (error) {
            setAttachError(
                `${t('sessions.file.attachFailedTitle')}. ${mobileErrorMessage(error, t('sessions.file.unreadable'), t)}`,
            );
        }
    };

    const remove = (id: string) => {
        fileAttachmentStore.cancel(id);
        update((current) => removeAttachment(current, id));
    };

    /**
     * Uploads a failed or expired file again from the phone's copy, under a new ID: the Server may hold part of the old
     * one.
     */
    const retry = async (id: string) => {
        const item = fileAttachmentStore.get(key).find((candidate) => candidate.id === id);
        if (!item) return;
        const replacement: FileAttachment = {
            id: newAttachmentId(),
            uri: item.uri,
            name: item.name,
            size: item.size,
            ...(item.mimeType !== undefined && { mimeType: item.mimeType }),
            progress: 0,
            state: 'uploading',
        };
        update((current) =>
            current.map((candidate) => (candidate.id === id ? replacement : candidate)),
        );
        await upload(replacement);
    };

    return {
        add,
        attachError,
        attachments,
        canAdd: attachments.length < MAX_MOBILE_FILE_ATTACHMENTS,
        pick,
        remaining,
        readyIds: attachments.filter((item) => item.state === 'ready').map((item) => item.id),
        /**
         * Each ready file's path on the computer, for a Chat message to cite.
         */
        readyPaths: attachments.flatMap((item) =>
            item.state === 'ready' && item.path ? [item.path] : [],
        ),
        /**
         * Why Send waits on the files, or `null` once they are all uploaded.
         */
        waitReason: fileAttachmentWaitReason(attachments, t),
        remove,
        retry,
        failure: attachments.find((item) => item.id === failedId),
        explainFailure: setFailedId,
        dismissFailure: () => setFailedId(undefined),
        clear: () => {
            setAttachError(null);
            update(() => []);
        },
        /**
         * Puts back files whose message failed to send, ahead of any attached since. Their uploads are still on the
         * Server, so they are ready to send again.
         */
        restore: (returned: readonly FileAttachment[]) =>
            update((current) => attachmentsWithReturned(current, returned)),
    };
};

export type FileAttachments = ReturnType<typeof useFileAttachments>;
