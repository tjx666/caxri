import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RotateCw, X } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { insertComposerSuggestion } from '../composer-suggestions';
import type { useComposerSuggestions } from '../hooks/use-composer-suggestions';
import type { useImageAttachments } from '../hooks/use-image-attachments';

type Images = ReturnType<typeof useImageAttachments>;
type Suggestions = ReturnType<typeof useComposerSuggestions>;

const THUMBNAIL_SIZE = 64;

const styles = StyleSheet.create({
    strip: { flexDirection: 'row', gap: 10, paddingTop: 6 },
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
    scrimText: { color: '#fff', fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '600' },
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
 * Pending images as thumbnails above the composer. A ready image needs no caption; upload progress and failure sit on a
 * scrim over the picture, and the failed scrim is itself the retry target.
 */
export const SessionComposerAttachments = ({
    images,
    theme,
}: {
    images: Images;
    theme: MobileTheme;
}) =>
    images.attachments.length > 0 ? (
        // A message carries at most three images, which always fit one row without scrolling.
        <View style={styles.strip} testID="session-image-attachments">
            {images.attachments.map((attachment, index) => (
                <Animated.View
                    entering={FadeIn.duration(160)}
                    exiting={FadeOut.duration(120)}
                    key={attachment.id}
                    layout={LinearTransition.duration(180)}
                    style={styles.attachment}
                >
                    <View style={[styles.thumbnail, { borderColor: theme.border }]}>
                        <Image
                            accessibilityLabel="Attached image preview"
                            source={{ uri: attachment.uri }}
                            style={styles.image}
                        />
                        {attachment.state === 'uploading' ? (
                            <View style={styles.scrim}>
                                <Text
                                    style={styles.scrimText}
                                    testID={`session-image-status-${index}`}
                                >
                                    {Math.round(attachment.progress * 100)}%
                                </Text>
                            </View>
                        ) : null}
                        {attachment.state === 'failed' ? (
                            <Pressable
                                accessibilityHint="Upload failed. Tap to try again."
                                accessibilityLabel="Retry image upload"
                                accessibilityRole="button"
                                onPress={() => images.retry(attachment.id)}
                                style={styles.scrim}
                            >
                                <RotateCw color={theme.danger} size={18} strokeWidth={2.5} />
                                <Text
                                    style={[styles.scrimText, { color: theme.danger }]}
                                    testID={`session-image-status-${index}`}
                                >
                                    Retry
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                    <Pressable
                        accessibilityLabel="Remove image"
                        accessibilityRole="button"
                        hitSlop={12}
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
            ))}
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
