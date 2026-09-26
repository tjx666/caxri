import { Image, Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { insertComposerSuggestion } from '../composer-suggestions';
import type { useComposerSuggestions } from '../hooks/use-composer-suggestions';
import type { useImageAttachments } from '../hooks/use-image-attachments';
import { sessionDetailStyles as styles } from './session-detail-styles';

type Images = ReturnType<typeof useImageAttachments>;
type Suggestions = ReturnType<typeof useComposerSuggestions>;

export const SessionComposerAttachments = ({
    images,
    theme,
}: {
    images: Images;
    theme: MobileTheme;
}) => (
    <>
        {images.attachments.length > 0 ? (
            <View style={styles.composerMeta} testID="session-image-attachments">
                {images.attachments.map((attachment, index) => (
                    <View key={attachment.id}>
                        <Image
                            accessibilityLabel="Attached image preview"
                            source={{ uri: attachment.uri }}
                            style={{ width: 72, height: 72 }}
                        />
                        <Text
                            style={{
                                color: attachment.state === 'failed' ? theme.danger : theme.muted,
                            }}
                            testID={`session-image-status-${index}`}
                        >
                            {attachment.state === 'uploading'
                                ? `Uploading ${Math.round(attachment.progress * 100)}%`
                                : attachment.state === 'failed'
                                  ? 'Upload failed'
                                  : 'Ready'}
                        </Text>
                        {attachment.state === 'failed' ? (
                            <Pressable
                                accessibilityLabel="Retry image upload"
                                accessibilityRole="button"
                                onPress={() => images.retry(attachment.id)}
                            >
                                <Text style={{ color: theme.primary }}>Retry</Text>
                            </Pressable>
                        ) : null}
                        <Pressable
                            accessibilityLabel="Remove image"
                            accessibilityRole="button"
                            onPress={() => images.remove(attachment.id)}
                            testID={`session-image-remove-${index}`}
                        >
                            <Text style={{ color: theme.muted }}>Remove</Text>
                        </Pressable>
                    </View>
                ))}
            </View>
        ) : null}
    </>
);

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
