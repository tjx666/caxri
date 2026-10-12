import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import { encodeHex } from '@caxri/mobile-transport';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { useMobileClient } from '../../connection/mobile-client-provider';
import {
    CHAT_THUMBNAIL_QUALITIES,
    chatThumbnailSize,
    isWithinChatThumbnailLimit,
    splitMobileImage,
} from '../image-attachment';
import type { ImageAttachment } from '../image-attachment-store';
import {
    completeImageAttachment,
    expireImageAttachments,
    imageAttachmentKey,
    imageAttachmentStore,
    imageAttachmentWaitReason,
    patchImageAttachment,
    removeImageAttachment,
} from '../image-attachment-store';
import { didUploadImageChunks } from '../image-upload';

/**
 * The largest number of images one Terminal Agent message may carry; a Chat takes `MAX_AGENT_CHAT_IMAGES`.
 */
const MAX_ATTACHMENTS = 3;

const newAttachmentId = (): string => `image_${encodeHex(Crypto.getRandomBytes(16))}`;

/**
 * A small JPEG of the prepared image for a Chat message's preview. The Server carries the thumbnail but cannot make
 * one, so the phone renders it here, lowering the quality until it fits the projection's thumbnail limit.
 */
const renderChatThumbnail = async (uri: string, width: number, height: number): Promise<string> => {
    for (const compress of CHAT_THUMBNAIL_QUALITIES) {
        const context = ImageManipulator.ImageManipulator.manipulate(uri);
        context.resize(chatThumbnailSize(width, height));
        // eslint-disable-next-line no-await-in-loop -- Each lower quality is tried only when the previous one was too large.
        const rendered = await context.renderAsync();
        // eslint-disable-next-line no-await-in-loop -- Same as above.
        const thumbnail = await rendered.saveAsync({
            format: ImageManipulator.SaveFormat.JPEG,
            compress,
            base64: true,
        });
        if (thumbnail.base64 && isWithinChatThumbnailLimit(thumbnail.base64))
            return thumbnail.base64;
    }
    throw new Error('Unable to prepare a preview of this image.');
};

export type ImageSource = 'library' | 'camera' | 'clipboard';

const failureMessage = (error: unknown): string =>
    error instanceof Error && error.message.length > 0 ? error.message : 'Upload failed.';

/**
 * The pending images of one composer. They live in `imageAttachmentStore` rather than component state, so leaving the
 * composer and coming back keeps them, and an upload started before leaving still finishes.
 */
export const useImageAttachments = (
    sessionId: string,
    {
        maxAttachments = MAX_ATTACHMENTS,
        surface = 'terminal',
        withThumbnail = false,
    }: {
        maxAttachments?: number;
        /**
         * Which composer owns the strip; a Chat and a Terminal composer never share pending images.
         */
        surface?: 'chat' | 'terminal';
        /**
         * Also prepares and uploads a thumbnail per image, as an Agent Chat message carries one.
         */
        withThumbnail?: boolean;
    } = {},
) => {
    const { connectionScopeKey, request } = useMobileClient();
    const key = imageAttachmentKey(connectionScopeKey, surface, sessionId);
    const subscribe = useCallback(
        (listener: () => void) => imageAttachmentStore.subscribe(key, listener),
        [key],
    );
    const snapshot = useCallback(() => imageAttachmentStore.get(key), [key]);
    const attachments = useSyncExternalStore(subscribe, snapshot, snapshot);
    const update = (change: (current: readonly ImageAttachment[]) => readonly ImageAttachment[]) =>
        imageAttachmentStore.update(key, change);
    // Pending images outlive the composer; one the Server has deleted since must not look ready on return.
    useEffect(() => {
        imageAttachmentStore.update(key, (current) => expireImageAttachments(current, Date.now()));
    }, [key]);

    const upload = async (item: ImageAttachment) => {
        try {
            if (!item.base64)
                throw new Error('This image is no longer available. Attach it again.');
            const parts = [
                { id: item.id, chunks: splitMobileImage(item.base64) },
                ...(item.thumbnail?.base64
                    ? [{ id: item.thumbnail.id, chunks: splitMobileImage(item.thumbnail.base64) }]
                    : []),
            ];
            const total = parts.reduce((sum, part) => sum + part.chunks.length, 0);
            let sent = 0;
            for (const part of parts) {
                const before = sent;
                // eslint-disable-next-line no-await-in-loop -- The thumbnail follows its image, so progress stays monotonic.
                const completed = await didUploadImageChunks(
                    part.chunks,
                    async (chunkIndex, chunk, chunkCount) => {
                        await request('mobile.image.upload', {
                            sessionId,
                            attachmentId: part.id,
                            chunkIndex,
                            chunkCount,
                            chunk,
                        });
                    },
                    () => imageAttachmentStore.isCancelled(item.id),
                    (progress) =>
                        update((current) =>
                            patchImageAttachment(current, item.id, {
                                progress: (before + progress * part.chunks.length) / total,
                            }),
                        ),
                );
                if (!completed) return;
                sent += part.chunks.length;
            }
            update((current) => completeImageAttachment(current, item.id, Date.now()));
        } catch (error) {
            update((current) =>
                patchImageAttachment(current, item.id, {
                    state: 'failed',
                    error: failureMessage(error),
                }),
            );
        }
    };

    /**
     * Prepares a picked image into an upload: a JPEG at most 1600 wide, plus a Chat thumbnail when asked for one.
     */
    const prepare = async (source: {
        uri: string;
        width: number;
        height: number;
        base64?: string;
    }): Promise<Pick<ImageAttachment, 'base64' | 'thumbnail' | 'uri'>> => {
        let { uri, base64 } = source;
        let size = { width: source.width, height: source.height };
        if (base64 === undefined) {
            const context = ImageManipulator.ImageManipulator.manipulate(source.uri);
            if (source.width > 1_600) context.resize({ width: 1_600 });
            const rendered = await context.renderAsync();
            const image = await rendered.saveAsync({
                format: ImageManipulator.SaveFormat.JPEG,
                compress: 0.75,
                base64: true,
            });
            if (!image.base64) throw new Error('Unable to prepare this image.');
            uri = image.uri;
            base64 = image.base64;
            size = { width: image.width, height: image.height };
        }
        splitMobileImage(base64);
        return {
            uri,
            base64,
            ...(withThumbnail && {
                thumbnail: {
                    id: newAttachmentId(),
                    base64: await renderChatThumbnail(uri, size.width, size.height),
                },
            }),
        };
    };

    const add = async (source: ImageSource) => {
        if (imageAttachmentStore.get(key).length >= maxAttachments) return;
        const id = newAttachmentId();
        try {
            let picked: { uri: string; width: number; height: number; base64?: string };
            if (source === 'clipboard') {
                const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.75 });
                if (!image) throw new Error('The clipboard has no image.');
                picked = {
                    uri: image.data,
                    base64: image.data.replace(/^data:image\/jpeg;base64,/u, ''),
                    ...image.size,
                };
            } else {
                const result =
                    source === 'camera'
                        ? await ImagePicker.launchCameraAsync({
                              mediaTypes: ['images'],
                              quality: 1,
                          })
                        : await ImagePicker.launchImageLibraryAsync({
                              mediaTypes: ['images'],
                              quality: 1,
                          });
                if (result.canceled || !result.assets[0]) return;
                const asset = result.assets[0];
                picked = { uri: asset.uri, width: asset.width, height: asset.height };
            }
            // Another pick may have filled the strip while the picker was open.
            if (imageAttachmentStore.get(key).length >= maxAttachments) return;
            // The picked picture shows at once as `Preparing…` while it is resized and compressed.
            update((current) => [
                ...current,
                { id, uri: picked.uri, progress: 0, state: 'preparing' },
            ]);
            const prepared = await prepare(picked);
            if (imageAttachmentStore.isCancelled(id)) return;
            const item: ImageAttachment = { id, progress: 0, state: 'uploading', ...prepared };
            update((current) =>
                patchImageAttachment(current, id, { ...prepared, state: 'uploading' }),
            );
            await upload(item);
        } catch (error) {
            update((current) => removeImageAttachment(current, id));
            Alert.alert(
                'Unable to attach image',
                error instanceof Error ? error.message : 'Try another image.',
            );
        }
    };

    const remove = (id: string) => {
        imageAttachmentStore.cancel(id);
        update((current) => removeImageAttachment(current, id));
    };

    const retry = async (id: string) => {
        const item = imageAttachmentStore.get(key).find((candidate) => candidate.id === id);
        if (!item) return;
        const replacement: ImageAttachment = {
            id: newAttachmentId(),
            uri: item.uri,
            ...(item.base64 !== undefined && { base64: item.base64 }),
            ...(item.thumbnail && {
                thumbnail: { ...item.thumbnail, id: newAttachmentId() },
            }),
            state: 'uploading',
            progress: 0,
        };
        update((current) =>
            current.map((candidate) => (candidate.id === id ? replacement : candidate)),
        );
        await upload(replacement);
    };

    return {
        add,
        attachments,
        canAdd: attachments.length < maxAttachments,
        readyIds: attachments.filter((item) => item.state === 'ready').map((item) => item.id),
        /**
         * Each ready Chat image with its uploaded thumbnail, as `mobile.agentChat.send` names them.
         */
        readyChatImages: attachments.flatMap((item) =>
            item.state === 'ready' && item.thumbnail
                ? [{ attachmentId: item.id, thumbnailAttachmentId: item.thumbnail.id }]
                : [],
        ),
        hasUnsentAttachment: attachments.some((item) => item.state !== 'ready'),
        /**
         * Why Send waits on the images, or `null` once they are all uploaded.
         */
        waitReason: imageAttachmentWaitReason(attachments),
        remove,
        retry,
        /**
         * Shows why an upload failed and lets the user retry or remove the image.
         */
        explainFailure: (id: string) => {
            const item = imageAttachmentStore.get(key).find((candidate) => candidate.id === id);
            if (!item) return;
            Alert.alert('Image upload failed', item.error ?? 'Upload failed.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => remove(id) },
                {
                    text: 'Retry',
                    onPress: () => {
                        // eslint-disable-next-line no-void -- A failed retry marks the image failed again.
                        void retry(id);
                    },
                },
            ]);
        },
        clear: () => update(() => []),
    };
};
