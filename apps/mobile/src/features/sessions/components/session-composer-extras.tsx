import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RotateCw, X } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { insertComposerSuggestion } from '../composer-suggestions';
import type { useComposerSuggestions } from '../hooks/use-composer-suggestions';
import type { useImageAttachments } from '../hooks/use-image-attachments';
import { imageAttachmentAccessibilityLabel } from '../image-attachment-store';

type Images = ReturnType<typeof useImageAttachments>;
type Suggestions = ReturnType<typeof useComposerSuggestions>;

const THUMBNAIL_SIZE = 64;

/**
 * The remove button's touch area grows past its 22dp circle only toward the outside corner and by less than half the
 * strip gap toward the next thumbnail, so it never covers a neighbor or most of its own picture's Retry target.
 */
const REMOVE_HIT_SLOP = { top: 10, right: 6, bottom: 6, left: 6 } as const;

const styles = StyleSheet.create({
    strip: { flexDirection: 'row', gap: 16, paddingTop: 6 },
    attachment: { height: THUMBNAIL_SIZE, width: THUMBNAIL_SIZE },
    thumbnail: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: THUMBNAIL_SIZE,
        overflow: 'hidden',
        width: THUMBNAIL_SIZE,
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
        borderRadius: 11,
        borderWidth: StyleSheet.hairlineWidth,
        height: 22,
        justifyContent: 'center',
        position: 'absolute',
        right: -6,
        top: -6,
        width: 22,
    },
});

/**
 * Pending images as thumbnails above the composer. A ready image needs no caption; preparation, upload progress, and
 * failure sit on a scrim over the picture. The failed scrim opens the failure reason with Retry and Remove.
 */
export const SessionComposerAttachments = ({
    images,
    theme,
}: {
    images: Images;
    theme: MobileTheme;
}) =>
    images.attachments.length > 0 ? (
        // A message carries at most four images (three on a Terminal), which always fit one row without scrolling.
        <View style={styles.strip} testID="session-image-attachments">
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
                            hitSlop={REMOVE_HIT_SLOP}
                            onPress={() => images.remove(attachment.id)}
                            style={[
                                styles.remove,
                                { backgroundColor: theme.elevated, borderColor: theme.border },
                            ]}
                            testID={`session-image-remove-${index}`}
                        >
                            <X color={theme.text} size={13} strokeWidth={2.75} />
                        </Pressable>
                    </Animated.View>
                );
            })}
        </View>
    ) : null;

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
