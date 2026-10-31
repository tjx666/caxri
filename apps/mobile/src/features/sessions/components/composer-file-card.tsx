/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
    File,
    FileArchive,
    FileImage,
    FileMusic,
    FileText,
    FileVideoCamera,
    RotateCw,
    X,
} from 'lucide-react-native';

import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { FileAttachment, FileAttachmentKind } from '../file-attachment-store';
import { fileAttachmentKind, formatFileSize } from '../file-attachment-store';
import {
    IMAGE_STRIP_REMOVE_CIRCLE,
    IMAGE_STRIP_REMOVE_OVERHANG,
    IMAGE_STRIP_REMOVE_TARGET,
    IMAGE_STRIP_THUMBNAIL,
} from '../image-strip-layout';

const CARD_WIDTH = 176;

const GLYPHS: Record<FileAttachmentKind, typeof File> = {
    archive: FileArchive,
    audio: FileMusic,
    document: FileText,
    image: FileImage,
    other: File,
    video: FileVideoCamera,
};

/**
 * A pending file in the composer's strip, beside the image thumbnails and as tall as one: its kind's glyph, its name,
 * and its size, upload progress, or Retry. The remove target overhangs its top end corner like a thumbnail's.
 */
export const ComposerFileCard = ({
    file,
    onExplainFailure,
    onRemove,
    theme,
}: {
    file: FileAttachment;
    onExplainFailure: () => void;
    onRemove: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const Glyph = GLYPHS[fileAttachmentKind(file)];
    const percent = Math.round(file.progress * 100);
    const label = t('sessions.file.label', { name: file.name, size: formatFileSize(file.size) });
    const accessibilityLabel =
        file.state === 'uploading'
            ? t('sessions.file.labelUploading', { label, percent })
            : file.state === 'failed'
              ? t('sessions.file.labelFailed', { label })
              : label;
    const isFailed = file.state === 'failed';
    return (
        <View style={styles.cell}>
            <Pressable
                accessibilityHint={isFailed ? t('sessions.image.failedHint') : undefined}
                accessibilityLabel={accessibilityLabel}
                accessibilityRole={isFailed ? 'button' : undefined}
                disabled={!isFailed}
                onPress={onExplainFailure}
                style={[
                    styles.card,
                    {
                        backgroundColor: theme.surface,
                        borderColor: isFailed ? theme.danger : theme.border,
                    },
                ]}
                testID={`session-file-${file.id}`}
            >
                <Glyph color={theme.muted} size={24} strokeWidth={1.75} />
                <View style={styles.text}>
                    <Text
                        ellipsizeMode="middle"
                        numberOfLines={1}
                        style={[mobileType.meta, styles.name, { color: theme.text }]}
                    >
                        {file.name}
                    </Text>
                    {isFailed ? (
                        <View style={styles.retry}>
                            <RotateCw color={theme.danger} size={12} strokeWidth={2.5} />
                            <Text style={[mobileType.caption, { color: theme.danger }]}>
                                {t('common.retry')}
                            </Text>
                        </View>
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
    text: { flex: 1, gap: 2 },
    name: { fontWeight: '600' },
    detail: { fontVariant: ['tabular-nums'] },
    retry: { alignItems: 'center', flexDirection: 'row', gap: 4 },
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
