/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';

import { ImageIcon } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { AgentChatImageViewer } from './agent-chat-image-viewer';
import { useAgentChatImage } from './use-agent-chat-image';

const THUMBNAIL_HEIGHT = 96;

const Thumbnail = ({
    index,
    itemId,
    onOpen,
    terminalId,
    theme,
}: {
    index: number;
    itemId: string;
    onOpen: () => void;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const thumbnail = useAgentChatImage({ terminalId, itemId, index, variant: 'thumbnail' });
    // A resumed conversation knows the image but not its preview, so the tile shows the original, as Desktop does.
    const original = useAgentChatImage(
        { terminalId, itemId, index, variant: 'original' },
        thumbnail.isMissing,
    );
    const uri = thumbnail.uri ?? original.uri;
    return (
        <Pressable
            accessibilityHint="Opens the image at full size."
            accessibilityLabel={`Attachment ${index + 1}`}
            accessibilityRole="imagebutton"
            onPress={onOpen}
            style={[
                styles.thumbnail,
                uri ? null : styles.placeholder,
                { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            testID={`agent-chat-message-image-${itemId}-${index}`}
        >
            {uri ? (
                <Image
                    resizeMode="cover"
                    source={{ uri }}
                    style={styles.image}
                    testID={`agent-chat-message-thumbnail-${itemId}-${index}`}
                />
            ) : thumbnail.isLoading || original.isLoading ? (
                <ActivityIndicator color={theme.muted} />
            ) : (
                // The provider's record no longer has the image; the tile keeps its place.
                <ImageIcon color={theme.muted} size={24} />
            )}
        </Pressable>
    );
};

/**
 * A user message's images, right-aligned above its text like Desktop's message strip. Thumbnails load as the message
 * renders, and a tap opens the original at full size.
 */
export const AgentChatMessageImages = ({
    count,
    itemId,
    terminalId,
    theme,
}: {
    count: number;
    itemId: string;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    return (
        <View style={styles.strip} testID={`agent-chat-message-images-${itemId}`}>
            {Array.from({ length: count }, (_, index) => (
                <Thumbnail
                    index={index}
                    itemId={itemId}
                    key={index}
                    onOpen={() => setOpenIndex(index)}
                    terminalId={terminalId}
                    theme={theme}
                />
            ))}
            <AgentChatImageViewer
                onClose={() => setOpenIndex(null)}
                target={openIndex === null ? null : { terminalId, itemId, index: openIndex }}
                theme={theme}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    strip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        justifyContent: 'flex-end',
    },
    thumbnail: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: THUMBNAIL_HEIGHT,
        overflow: 'hidden',
        width: THUMBNAIL_HEIGHT,
    },
    placeholder: { alignItems: 'center', justifyContent: 'center' },
    image: { height: '100%', width: '100%' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
