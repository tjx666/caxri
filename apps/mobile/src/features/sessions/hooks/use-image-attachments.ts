import { useRef, useState } from 'react';
import { Alert } from 'react-native';

import { encodeHex } from '@caxri/mobile-transport';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { splitMobileImage } from '../image-attachment';
import { didUploadImageChunks } from '../image-upload';

interface Attachment {
    id: string;
    uri: string;
    progress: number;
    state: 'uploading' | 'ready' | 'failed';
    base64: string;
    error?: string;
}

export const useImageAttachments = (sessionId: string) => {
    const { request } = useMobileClient();
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const cancelled = useRef(new Set<string>());

    const upload = async (item: Attachment) => {
        try {
            const chunks = splitMobileImage(item.base64);
            const completed = await didUploadImageChunks(
                chunks,
                async (chunkIndex, chunk, chunkCount) => {
                    await request('mobile.image.upload', {
                        sessionId,
                        attachmentId: item.id,
                        chunkIndex,
                        chunkCount,
                        chunk,
                    });
                },
                () => cancelled.current.has(item.id),
                (progress) =>
                    setAttachments((current) =>
                        current.map((candidate) =>
                            candidate.id === item.id ? { ...candidate, progress } : candidate,
                        ),
                    ),
            );
            if (!completed) return;
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

    const add = async (source: 'library' | 'camera' | 'clipboard') => {
        if (attachments.length >= 3) return;
        try {
            let uri: string;
            let base64: string;
            if (source === 'clipboard') {
                const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.75 });
                if (!image) throw new Error('The clipboard has no image.');
                uri = image.data;
                base64 = image.data.replace(/^data:image\/jpeg;base64,/u, '');
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
            }
            splitMobileImage(base64);
            const item: Attachment = {
                id: `image_${encodeHex(Crypto.getRandomBytes(16))}`,
                uri,
                base64,
                progress: 0,
                state: 'uploading',
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

    const choose = () =>
        Alert.alert('Attach image', 'Choose an image source.', [
            {
                text: 'Photo library',
                onPress: async () => {
                    await add('library');
                },
            },
            {
                text: 'Camera',
                onPress: async () => {
                    await add('camera');
                },
            },
            {
                text: 'Paste',
                onPress: async () => {
                    await add('clipboard');
                },
            },
            { text: 'Cancel', style: 'cancel' },
        ]);

    return {
        attachments,
        choose,
        readyIds: attachments.filter((item) => item.state === 'ready').map((item) => item.id),
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
                id: `image_${encodeHex(Crypto.getRandomBytes(16))}`,
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
