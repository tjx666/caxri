import { useRef, useState } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RotateCw, X } from 'lucide-react-native';

import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { LocalImageViewer } from '../../agent-chat/agent-chat-image-viewer';
import { insertComposerSuggestion } from '../composer-suggestions';
import type { useComposerSuggestions } from '../hooks/use-composer-suggestions';
import type { useImageAttachments } from '../hooks/use-image-attachments';
import { imageAttachmentAccessibilityLabel } from '../image-attachment-store';
import {
    IMAGE_STRIP_CELL,
    IMAGE_STRIP_CELL_GAP,
    IMAGE_STRIP_REMOVE_CIRCLE,
    IMAGE_STRIP_REMOVE_OVERHANG,
    IMAGE_STRIP_REMOVE_TARGET,
    IMAGE_STRIP_THUMBNAIL,
} from '../image-strip-layout';
import { ImageFailureSheet } from './image-failure-sheet';

type Images = ReturnType<typeof useImageAttachments>;
type Suggestions = ReturnType<typeof useComposerSuggestions>;

const styles = StyleSheet.create({
    strip: { flexGrow: 0 },
    stripContent: { flexDirection: 'row', gap: IMAGE_STRIP_CELL_GAP },
    attachment: {
        height: IMAGE_STRIP_CELL,
        paddingTop: IMAGE_STRIP_REMOVE_OVERHANG,
        width: IMAGE_STRIP_CELL,
    },
    thumbnail: {
        borderRadius: mobileRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        height: IMAGE_STRIP_THUMBNAIL,
        overflow: 'hidden',
        width: IMAGE_STRIP_THUMBNAIL,
    },
    image: { height: '100%', width: '100%' },
    suggestion: {
        justifyContent: 'center',
        minHeight: mobileControl.row,
        padding: mobileSpace.sm,
    },
    scrim: {
        alignItems: 'center',
        gap: 2,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    scrimText: { ...mobileType.caption, fontVariant: ['tabular-nums'], fontWeight: '600' },
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

/**
 * Pending images as thumbnails above the composer. A ready image needs no caption; preparation (with a spinner), upload
 * progress, and failure sit on a scrim over the picture. The failed scrim opens the failure reason with Retry and
 * Remove. A Chat message carries up to `MAX_AGENT_CHAT_IMAGES`, more than a phone's width holds, so the strip scrolls
 * sideways and brings each newly attached image into view. A tap on a picture opens the pending images at full size, as
 * a sent message's images open, so the user can check one before sending.
 */
export const SessionComposerAttachments = ({
    images,
    theme,
}: {
    images: Images;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const strip = useRef<ScrollViewInstance>(null);
    const shownCount = useRef(images.attachments.length);
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    if (images.attachments.length === 0) return null;
    return (
        <>
            <ScrollView
                contentContainerStyle={styles.stripContent}
                horizontal
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => {
                    const count = images.attachments.length;
                    // Only a new image scrolls the strip; removing one leaves the reader where they were.
                    if (count > shownCount.current) strip.current?.scrollToEnd({ animated: true });
                    shownCount.current = count;
                }}
                ref={strip}
                showsHorizontalScrollIndicator={false}
                style={styles.strip}
                testID="session-image-attachments"
            >
                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- At most 20 images; virtualizing would only break the strip's layout animation. */}
                {images.attachments.map((attachment, index) => {
                    const label = imageAttachmentAccessibilityLabel(
                        attachment,
                        index,
                        images.attachments.length,
                        t,
                    );
                    return (
                        <Animated.View
                            entering={FadeIn.duration(160)}
                            exiting={FadeOut.duration(120)}
                            key={attachment.id}
                            layout={LinearTransition.duration(180)}
                            style={styles.attachment}
                        >
                            <View style={[styles.thumbnail, { borderColor: theme.border }]}>
                                <Pressable
                                    accessibilityHint={t('chat.image.openHint')}
                                    accessibilityLabel={label}
                                    accessibilityRole="imagebutton"
                                    onPress={() => setOpenIndex(index)}
                                    style={styles.image}
                                    testID={`session-image-open-${index}`}
                                >
                                    <Image source={{ uri: attachment.uri }} style={styles.image} />
                                </Pressable>
                                {attachment.state === 'preparing' ||
                                attachment.state === 'uploading' ? (
                                    <View
                                        style={[styles.scrim, { backgroundColor: theme.overlay }]}
                                    >
                                        {attachment.state === 'preparing' ? (
                                            <Spinner color={theme.onScrim} />
                                        ) : null}
                                        <Text
                                            style={[styles.scrimText, { color: theme.onScrim }]}
                                            testID={`session-image-status-${index}`}
                                        >
                                            {attachment.state === 'preparing'
                                                ? t('sessions.image.preparing')
                                                : `${Math.round(attachment.progress * 100)}%`}
                                        </Text>
                                    </View>
                                ) : null}
                                {attachment.state === 'failed' ? (
                                    <Pressable
                                        accessibilityHint={t('sessions.image.failedHint')}
                                        accessibilityLabel={label}
                                        accessibilityRole="button"
                                        onPress={() => images.explainFailure(attachment.id)}
                                        style={[styles.scrim, { backgroundColor: theme.overlay }]}
                                    >
                                        <RotateCw
                                            color={theme.onScrim}
                                            size={18}
                                            strokeWidth={2.5}
                                        />
                                        <Text
                                            style={[styles.scrimText, { color: theme.onScrim }]}
                                            testID={`session-image-status-${index}`}
                                        >
                                            {t('common.retry')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>
                            <Pressable
                                accessibilityLabel={t('sessions.image.removeLabel', {
                                    index: index + 1,
                                })}
                                accessibilityRole="button"
                                onPress={() => images.remove(attachment.id)}
                                style={styles.remove}
                                testID={`session-image-remove-${index}`}
                            >
                                <View
                                    style={[
                                        styles.removeCircle,
                                        {
                                            backgroundColor: theme.elevated,
                                            borderColor: theme.border,
                                        },
                                    ]}
                                >
                                    <X color={theme.text} size={13} strokeWidth={2.75} />
                                </View>
                            </Pressable>
                        </Animated.View>
                    );
                })}
            </ScrollView>
            {images.failure ? (
                <ImageFailureSheet
                    onClose={images.dismissFailure}
                    onRemove={() => {
                        if (images.failure) images.remove(images.failure.id);
                    }}
                    onRetry={() => {
                        if (images.failure) void images.retry(images.failure.id);
                    }}
                    reason={images.failure.error ?? t('sessions.image.uploadFailed')}
                    theme={theme}
                />
            ) : null}
            <LocalImageViewer
                onClose={() => setOpenIndex(null)}
                startIndex={openIndex}
                theme={theme}
                uris={images.attachments.map((attachment) => attachment.uri)}
            />
        </>
    );
};

export const SessionComposerSuggestions = ({
    draft,
    suggestions,
    theme,
    updateDraft,
}: {
    draft: string;
    suggestions: Suggestions;
    theme: MobileTheme;
    updateDraft: (value: string) => void;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {suggestions.trigger ? (
                <View testID="session-composer-suggestions">
                    {suggestions.items.slice(0, 10).map((item, index) => (
                        <Pressable
                            accessibilityLabel={t('sessions.composer.insertSuggestion', { item })}
                            accessibilityRole="button"
                            key={item}
                            onPress={() =>
                                updateDraft(
                                    insertComposerSuggestion(
                                        draft,
                                        suggestions.trigger.token,
                                        item,
                                    ),
                                )
                            }
                            style={styles.suggestion}
                            testID={`session-composer-suggestion-${index}`}
                        >
                            <Text style={[mobileType.body, { color: theme.text }]}>{item}</Text>
                        </Pressable>
                    ))}
                    {suggestions.isError ? (
                        <Text
                            accessibilityRole="alert"
                            style={[mobileType.meta, { color: theme.danger }]}
                        >
                            {t('sessions.composer.suggestionsUnavailable')}
                        </Text>
                    ) : null}
                </View>
            ) : null}
        </>
    );
};
