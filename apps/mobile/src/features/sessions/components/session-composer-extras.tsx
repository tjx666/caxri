import { useRef } from 'react';
import {
    ActivityIndicator,
    Image,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RotateCw, X } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
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
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: IMAGE_STRIP_THUMBNAIL,
        overflow: 'hidden',
        width: IMAGE_STRIP_THUMBNAIL,
    },
    image: { height: '100%', width: '100%' },
    scrim: {
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        gap: 2,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    scrimText: { fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '600' },
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
 * sideways and brings each newly attached image into view.
 */
export const SessionComposerAttachments = ({
    images,
    theme,
}: {
    images: Images;
    theme: MobileTheme;
}) => {
    const strip = useRef<ScrollView>(null);
    const shownCount = useRef(images.attachments.length);
    if (images.attachments.length === 0) return null;
    return (
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
                            <Image
                                accessibilityLabel={label}
                                source={{ uri: attachment.uri }}
                                style={styles.image}
                            />
                            {attachment.state === 'preparing' ||
                            attachment.state === 'uploading' ? (
                                <View style={styles.scrim}>
                                    {attachment.state === 'preparing' ? (
                                        <ActivityIndicator color={theme.text} size="small" />
                                    ) : null}
                                    <Text
                                        style={[styles.scrimText, { color: theme.text }]}
                                        testID={`session-image-status-${index}`}
                                    >
                                        {attachment.state === 'preparing'
                                            ? 'Preparing…'
                                            : `${Math.round(attachment.progress * 100)}%`}
                                    </Text>
                                </View>
                            ) : null}
                            {attachment.state === 'failed' ? (
                                <Pressable
                                    accessibilityHint="Shows why the upload failed, with Retry and Remove."
                                    accessibilityLabel={label}
                                    accessibilityRole="button"
                                    onPress={() => images.explainFailure(attachment.id)}
                                    style={styles.scrim}
                                >
                                    <RotateCw color={theme.text} size={18} strokeWidth={2.5} />
                                    <Text
                                        style={[styles.scrimText, { color: theme.text }]}
                                        testID={`session-image-status-${index}`}
                                    >
                                        Retry
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                        <Pressable
                            accessibilityLabel={`Remove image ${index + 1}`}
                            accessibilityRole="button"
                            onPress={() => images.remove(attachment.id)}
                            style={styles.remove}
                            testID={`session-image-remove-${index}`}
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
                    </Animated.View>
                );
            })}
        </ScrollView>
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
}) => (
    <>
        {suggestions.trigger ? (
            <View testID="session-composer-suggestions">
                {suggestions.items.slice(0, 10).map((item, index) => (
                    <Pressable
                        accessibilityLabel={`Insert ${item}`}
                        accessibilityRole="button"
                        key={item}
                        onPress={() =>
                            updateDraft(
                                insertComposerSuggestion(draft, suggestions.trigger.token, item),
                            )
                        }
                        style={{ minHeight: 44, justifyContent: 'center', padding: 8 }}
                        testID={`session-composer-suggestion-${index}`}
                    >
                        <Text style={{ color: theme.text }}>{item}</Text>
                    </Pressable>
                ))}
                {suggestions.isError ? (
                    <Text accessibilityRole="alert" style={{ color: theme.danger }}>
                        Suggestions are unavailable. You can still type the command or path.
                    </Text>
                ) : null}
            </View>
        ) : null}
    </>
);
