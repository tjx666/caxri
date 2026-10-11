import { useRef, useState } from 'react';
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

interface Attachment {
    id: string;
    uri: string;
    progress: number;
    state: 'uploading' | 'ready' | 'failed';
    base64: string;
    /**
     * A Chat image's preview, uploaded after the image under its own ID.
     */
    thumbnail?: { id: string; base64: string };
    error?: string;
}

export const useImageAttachments = (
    sessionId: string,
    {
        maxAttachments = MAX_ATTACHMENTS,
        withThumbnail = false,
    }: {
        maxAttachments?: number;
        /**
         * Also prepares and uploads a thumbnail per image, as an Agent Chat message carries one.
         */
        withThumbnail?: boolean;
    } = {},
) => {
    const { request } = useMobileClient();
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const cancelled = useRef(new Set<string>());

    const upload = async (item: Attachment) => {
        try {
            const parts = [
                { id: item.id, chunks: splitMobileImage(item.base64) },
                ...(item.thumbnail
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
                    () => cancelled.current.has(item.id),
                    (progress) =>
                        setAttachments((current) =>
                            current.map((candidate) =>
                                candidate.id === item.id
                                    ? {
                                          ...candidate,
                                          progress:
                                              (before + progress * part.chunks.length) / total,
                                      }
                                    : candidate,
                            ),
                        ),
                );
                if (!completed) return;
                sent += part.chunks.length;
            }
            setAttachments((current) =>
                current.map((candidate) =>
                    candidate.id === item.id
                        ? { ...candidate, state: 'ready', progress: 1 }
                        : candidate,
                ),
            );
        } catch (error) {
            setAttachments((current) =>
                current.map((candidate) =>
                    candidate.id === item.id
                        ? {
                              ...candidate,
                              state: 'failed',
                              error: error instanceof Error ? error.message : 'Upload failed.',
                          }
                        : candidate,
                ),
            );
        }
    };

    const add = async (source: ImageSource) => {
        if (attachments.length >= maxAttachments) return;
        try {
            let uri: string;
            let base64: string;
            let size: { width: number; height: number };
            if (source === 'clipboard') {
                const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.75 });
                if (!image) throw new Error('The clipboard has no image.');
                uri = image.data;
                base64 = image.data.replace(/^data:image\/jpeg;base64,/u, '');
                size = image.size;
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
                const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
                if (asset.width > 1_600) context.resize({ width: 1_600 });
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
            const item: Attachment = {
                id: newAttachmentId(),
                uri,
                base64,
                progress: 0,
                state: 'uploading',
                ...(withThumbnail && {
                    thumbnail: {
                        id: newAttachmentId(),
                        base64: await renderChatThumbnail(uri, size.width, size.height),
                    },
                }),
            };
            setAttachments((current) => [...current, item]);
            await upload(item);
        } catch (error) {
            Alert.alert(
                'Unable to attach image',
                error instanceof Error ? error.message : 'Try another image.',
            );
        }
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
        remove: (id: string) => {
            cancelled.current.add(id);
            setAttachments((current) => current.filter((item) => item.id !== id));
        },
        retry: async (id: string) => {
            const item = attachments.find((candidate) => candidate.id === id);
            if (!item) return;
            const replacement = {
                ...item,
                id: newAttachmentId(),
                ...(item.thumbnail && {
                    thumbnail: { ...item.thumbnail, id: newAttachmentId() },
                }),
                state: 'uploading' as const,
                progress: 0,
            };
            setAttachments((current) =>
                current.map((candidate) => (candidate.id === id ? replacement : candidate)),
            );
            await upload(replacement);
        },
        clear: () => setAttachments([]),
    };
};
