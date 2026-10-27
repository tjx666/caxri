import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import { encodeHex } from '@caxri/mobile-transport';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage, MobileLocalizedError } from '../../connection/mobile-error-message';
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
    imageAttachmentsBase64Length,
    imageAttachmentStore,
    imageAttachmentsWithReturned,
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
const renderChatThumbnail = async (
    uri: string,
    width: number,
    height: number,
    t: Translate,
): Promise<string> => {
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
    throw new MobileLocalizedError(t('sessions.image.previewFailed'));
};

export type ImageSource = 'library' | 'camera' | 'clipboard';

/**
 * One image a source returned; a clipboard image arrives already encoded.
 */
interface PickedImage {
    uri: string;
    width: number;
    height: number;
    base64?: string;
}

const failureMessage = (error: unknown, t: Translate): string =>
    mobileErrorMessage(error, t('sessions.image.uploadFailed'), t);

/**
 * The pending images of one composer. They live in `imageAttachmentStore` rather than component state, so leaving the
 * composer and coming back keeps them, and an upload started before leaving still finishes.
 */
export const useImageAttachments = (
    sessionId: string,
    {
        maxAttachments = MAX_ATTACHMENTS,
        maxTotal,
        surface = 'terminal',
        withThumbnail = false,
    }: {
        maxAttachments?: number;
        /**
         * The combined base64 length one message's images may reach, and what the refusal says. An image that would
         * pass it is refused once prepared, before any of it uploads, since the Server would refuse the whole message.
         */
        maxTotal?: { base64Length: number; message: string };
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
    const { t } = useTranslation();
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
        imageAttachmentStore.update(key, (current) =>
            expireImageAttachments(current, Date.now(), t),
        );
    }, [key, t]);

    const upload = async (item: ImageAttachment) => {
        try {
            if (!item.base64) throw new MobileLocalizedError(t('sessions.image.unavailable'));
            const parts = [
                { id: item.id, chunks: splitMobileImage(item.base64, t) },
                ...(item.thumbnail?.base64
                    ? [
                          {
                              id: item.thumbnail.id,
                              chunks: splitMobileImage(item.thumbnail.base64, t),
                          },
                      ]
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
                    error: failureMessage(error, t),
                }),
            );
        }
    };

    /**
     * Prepares a picked image into an upload: a JPEG at most 1600 wide, plus a Chat thumbnail when asked for one.
     */
    const prepare = async (
        source: PickedImage,
    ): Promise<Pick<ImageAttachment, 'base64' | 'thumbnail' | 'uri'>> => {
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
            if (!image.base64) throw new MobileLocalizedError(t('sessions.image.prepareFailed'));
            uri = image.uri;
            base64 = image.base64;
            size = { width: image.width, height: image.height };
        }
        splitMobileImage(base64, t);
        return {
            uri,
            base64,
            ...(withThumbnail && {
                thumbnail: {
                    id: newAttachmentId(),
                    base64: await renderChatThumbnail(uri, size.width, size.height, t),
                },
            }),
        };
    };

    /**
     * Resizes, compresses, and uploads an image already shown as `Preparing…`. A failure removes the image and is
     * returned for the caller to report, so one bad image of several does not stop the rest.
     */
    const attach = async (id: string, picked: PickedImage): Promise<unknown> => {
        // Removed while an earlier image of the same pick was still uploading.
        if (imageAttachmentStore.isCancelled(id)) return undefined;
        try {
            const prepared = await prepare(picked);
            if (imageAttachmentStore.isCancelled(id)) return undefined;
            const base64Length = prepared.base64?.length ?? 0;
            if (
                maxTotal &&
                imageAttachmentsBase64Length(imageAttachmentStore.get(key), id) + base64Length >
                    maxTotal.base64Length
            )
                throw new MobileLocalizedError(maxTotal.message);
            const item: ImageAttachment = {
                id,
                progress: 0,
                state: 'uploading',
                base64Length,
                ...prepared,
            };
            update((current) =>
                patchImageAttachment(current, id, {
                    ...prepared,
                    base64Length,
                    state: 'uploading',
                }),
            );
            await upload(item);
            return undefined;
        } catch (error) {
            update((current) => removeImageAttachment(current, id));
            return error;
        }
    };

    const add = async (source: ImageSource) => {
        const remaining = () => maxAttachments - imageAttachmentStore.get(key).length;
        if (remaining() <= 0) return;
        let picked: PickedImage[];
        try {
            if (source === 'clipboard') {
                const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.75 });
                if (!image) throw new MobileLocalizedError(t('sessions.image.clipboardEmpty'));
                picked = [
                    {
                        uri: image.data,
                        base64: image.data.replace(/^data:image\/jpeg;base64,/u, ''),
                        ...image.size,
                    },
                ];
            } else {
                const result =
                    source === 'camera'
                        ? await ImagePicker.launchCameraAsync({
                              mediaTypes: ['images'],
                              quality: 1,
                          })
                        : await ImagePicker.launchImageLibraryAsync({
                              allowsMultipleSelection: true,
                              mediaTypes: ['images'],
                              orderedSelection: true,
                              quality: 1,
                              selectionLimit: remaining(),
                          });
                if (result.canceled) return;
                picked = result.assets.map(({ height, uri, width }) => ({ height, uri, width }));
            }
        } catch (error) {
            Alert.alert(
                t('sessions.image.attachFailedTitle'),
                mobileErrorMessage(error, t('sessions.image.attachFailedBody'), t),
            );
            return;
        }
        // Another pick may have filled the strip while the picker was open.
        const pending = picked
            .slice(0, Math.max(0, remaining()))
            .map((image) => ({ id: newAttachmentId(), image }));
        // Every picked image shows at once as `Preparing…`, then each is prepared and uploaded in turn, so the
        // combined-size limit sees the images before it.
        update((current) => [
            ...current,
            ...pending.map(({ id, image }) => ({
                id,
                uri: image.uri,
                progress: 0,
                state: 'preparing' as const,
            })),
        ]);
        let failure: unknown;
        for (const { id, image } of pending) {
            // Each image is checked against the ones prepared before it, so the uploads are sequential by design.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- see above
            const error = await attach(id, image); // eslint-disable-line no-await-in-loop -- see above
            failure ??= error;
        }
        if (failure !== undefined)
            Alert.alert(
                t('sessions.image.attachFailedTitle'),
                mobileErrorMessage(failure, t('sessions.image.attachFailedBody'), t),
            );
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
            ...(item.base64Length !== undefined && { base64Length: item.base64Length }),
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
        waitReason: imageAttachmentWaitReason(attachments, t),
        remove,
        retry,
        /**
         * Shows why an upload failed and lets the user retry or remove the image.
         */
        explainFailure: (id: string) => {
            const item = imageAttachmentStore.get(key).find((candidate) => candidate.id === id);
            if (!item) return;
            Alert.alert(
                t('sessions.image.uploadFailedTitle'),
                item.error ?? t('sessions.image.uploadFailed'),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('sessions.image.remove'),
                        style: 'destructive',
                        onPress: () => remove(id),
                    },
                    {
                        text: t('common.retry'),
                        onPress: () => {
                            void retry(id);
                        },
                    },
                ],
            );
        },
        clear: () => update(() => []),
        /**
         * Puts back images whose message failed to send, ahead of any attached since; one still attached is not added
         * twice. Their uploads are still on the Server, so they are ready to send again.
         */
        restore: (returned: readonly ImageAttachment[]) =>
            update((current) => imageAttachmentsWithReturned(current, returned)),
    };
};
