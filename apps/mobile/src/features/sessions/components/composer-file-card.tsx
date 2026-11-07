/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
    File,
    FileArchive,
    FileImage,
    FileMusic,
    FileText,
    FileVideoCamera,
    Play,
    RotateCw,
    X,
} from 'lucide-react-native';

import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { FileAttachment, FileAttachmentKind } from '../file-attachment-store';
import {
    fileAttachmentKind,
    fileAttachmentPreview,
    formatFileSize,
} from '../file-attachment-store';
import { useAttachmentCover } from '../hooks/use-attachment-cover';
import {
    IMAGE_STRIP_REMOVE_CIRCLE,
    IMAGE_STRIP_REMOVE_OVERHANG,
    IMAGE_STRIP_REMOVE_TARGET,
    IMAGE_STRIP_THUMBNAIL,
} from '../image-strip-layout';

const CARD_WIDTH = 176;
/**
 * Grows the small Retry label downward and sideways only: the file name sits just above it, so a tap there must still
 * preview.
 */
const RETRY_HIT_SLOP = { bottom: 12, left: 8, right: 8, top: 0 };

const GLYPHS: Record<FileAttachmentKind, typeof File> = {
    archive: FileArchive,
    audio: FileMusic,
    document: FileText,
    image: FileImage,
    other: File,
    video: FileVideoCamera,
};

/**
 * A pending file in the composer's strip, beside the image thumbnails and as tall as one: a cover (an image file
 * itself, or a video's first frame with a play mark) or else its kind's glyph, its name, and its size, upload progress,
 * or Retry. The remove target overhangs its top end corner like a thumbnail's.
 *
 * A tap previews an image, video, or recording from the phone's own copy in any upload state; a failed file keeps Retry
 * as its own target, which explains the failure. A file the phone cannot preview opens that explanation instead.
 */
export const ComposerFileCard = ({
    file,
    onExplainFailure,
    onOpen,
    onRemove,
    theme,
}: {
    file: FileAttachment;
    onExplainFailure: () => void;
    /**
     * Previews the phone's copy; called only for a file `fileAttachmentPreview` can show.
     */
    onOpen: () => void;
    onRemove: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const kind = fileAttachmentKind(file);
    const Glyph = GLYPHS[kind];
    const cover = useAttachmentCover(file);
    // A picture React Native cannot decode (some HEIC files) falls back to the glyph rather than an empty square.
    const [brokenCover, setBrokenCover] = useState<string>();
    const shownCover = cover !== undefined && cover !== brokenCover ? cover : undefined;
    const percent = Math.round(file.progress * 100);
    const label = t('sessions.file.label', { name: file.name, size: formatFileSize(file.size) });
    const accessibilityLabel =
        file.state === 'uploading'
            ? t('sessions.file.labelUploading', { label, percent })
            : file.state === 'failed'
              ? t('sessions.file.labelFailed', { label })
              : label;
    const isFailed = file.state === 'failed';
    const canPreview = fileAttachmentPreview(file) !== undefined;
    return (
        <View style={styles.cell}>
            <Pressable
                accessibilityHint={
                    canPreview
                        ? t('sessions.file.previewHint')
                        : isFailed
                          ? t('sessions.image.failedHint')
                          : undefined
                }
                accessibilityLabel={accessibilityLabel}
                accessibilityRole={canPreview || isFailed ? 'button' : undefined}
                disabled={!canPreview && !isFailed}
                onPress={canPreview ? onOpen : onExplainFailure}
                style={[
                    styles.card,
                    shownCover !== undefined && styles.cardWithCover,
                    {
                        backgroundColor: theme.surface,
                        borderColor: isFailed ? theme.danger : theme.border,
                    },
                ]}
                testID={`session-file-${file.id}`}
            >
                {shownCover === undefined ? (
                    <Glyph color={theme.muted} size={24} strokeWidth={1.75} />
                ) : (
                    <View
                        style={[styles.cover, { backgroundColor: theme.background }]}
                        testID={`session-file-cover-${file.id}`}
                    >
                        <Image
                            onError={() => setBrokenCover(shownCover)}
                            source={{ uri: shownCover }}
                            style={styles.coverImage}
                        />
                        {kind === 'video' ? (
                            <View
                                style={[styles.play, { backgroundColor: theme.scrimControl }]}
                                testID={`session-file-play-${file.id}`}
                            >
                                <Play color={theme.onScrim} fill={theme.onScrim} size={12} />
                            </View>
                        ) : null}
                    </View>
                )}
                <View style={styles.text}>
                    <Text
                        ellipsizeMode="middle"
                        numberOfLines={1}
                        style={[mobileType.meta, styles.name, { color: theme.text }]}
                    >
                        {file.name}
                    </Text>
                    {isFailed ? (
                        <Pressable
                            accessibilityHint={t('sessions.image.failedHint')}
                            accessibilityLabel={t('common.retry')}
                            accessibilityRole="button"
                            hitSlop={RETRY_HIT_SLOP}
                            onPress={onExplainFailure}
                            style={styles.retry}
                            testID={`session-file-retry-${file.id}`}
                        >
                            <RotateCw color={theme.danger} size={12} strokeWidth={2.5} />
                            <Text style={[mobileType.caption, { color: theme.danger }]}>
                                {t('common.retry')}
                            </Text>
                        </Pressable>
                    ) : (
                        <Text style={[mobileType.caption, styles.detail, { color: theme.muted }]}>
                            {file.state === 'uploading'
                                ? `${percent}% · ${formatFileSize(file.size)}`
                                : formatFileSize(file.size)}
                        </Text>
                    )}
                </View>
                {file.state === 'uploading' ? (
                    <View style={[styles.track, { backgroundColor: theme.border }]}>
                        <View
                            style={[
                                styles.bar,
                                { backgroundColor: theme.primary, width: `${percent}%` },
                            ]}
                        />
                    </View>
                ) : null}
            </Pressable>
            <Pressable
                accessibilityLabel={t('sessions.file.removeLabel', { name: file.name })}
                accessibilityRole="button"
                onPress={onRemove}
                style={styles.remove}
                testID={`session-file-remove-${file.id}`}
            >
                <View
                    style={[
                        styles.removeCircle,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                >
                    <X color={theme.text} size={13} strokeWidth={2.75} />
                </View>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    cell: {
        height: IMAGE_STRIP_THUMBNAIL + IMAGE_STRIP_REMOVE_OVERHANG,
        paddingTop: IMAGE_STRIP_REMOVE_OVERHANG,
        width: CARD_WIDTH + IMAGE_STRIP_REMOVE_OVERHANG,
    },
    card: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        height: IMAGE_STRIP_THUMBNAIL,
        overflow: 'hidden',
        paddingLeft: mobileSpace.sm,
        // Clears the remove circle that overhangs the top end corner.
        paddingRight: mobileSpace.md,
        width: CARD_WIDTH,
    },
    // The cover fills the card's start edge, as tall as an image thumbnail beside it.
    cardWithCover: { paddingLeft: 0 },
    cover: {
        alignItems: 'center',
        height: IMAGE_STRIP_THUMBNAIL,
        justifyContent: 'center',
        width: IMAGE_STRIP_THUMBNAIL,
    },
    coverImage: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    play: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        height: 24,
        justifyContent: 'center',
        width: 24,
    },
    text: { flex: 1, gap: 2 },
    name: { fontWeight: '600' },
    detail: { fontVariant: ['tabular-nums'] },
    retry: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 4 },
    track: { bottom: 0, height: 2, left: 0, position: 'absolute', right: 0 },
    bar: { height: 2 },
    remove: {
        alignItems: 'center',
        height: IMAGE_STRIP_REMOVE_TARGET,
        justifyContent: 'center',
        position: 'absolute',
        right: 0,
        top: 0,
        width: IMAGE_STRIP_REMOVE_TARGET,
    },
    removeCircle: {
        alignItems: 'center',
        borderRadius: IMAGE_STRIP_REMOVE_CIRCLE / 2,
        borderWidth: StyleSheet.hairlineWidth,
        height: IMAGE_STRIP_REMOVE_CIRCLE,
        justifyContent: 'center',
        width: IMAGE_STRIP_REMOVE_CIRCLE,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
