/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { X } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The full-screen player's backdrop and close button, shared by a message's streamed videos and the composer's local
 * ones so both open and close the same way.
 */
export const VideoPlayerFrame = ({
    children,
    onClose,
    theme,
}: {
    children: ReactNode;
    onClose: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    return (
        <View
            style={[styles.backdrop, { backgroundColor: theme.scrim }]}
            testID="agent-chat-video-player"
        >
            {children}
            <Pressable
                accessibilityLabel={t('chat.video.close')}
                accessibilityRole="button"
                hitSlop={12}
                onPress={onClose}
                style={[
                    styles.close,
                    { backgroundColor: theme.scrimControl, top: insets.top + 12 },
                ]}
                testID="agent-chat-video-player-close"
            >
                <X color={theme.onScrim} size={22} strokeWidth={2.5} />
            </Pressable>
        </View>
    );
};

export const PlayerMessage = ({
    message,
    onRetry,
    theme,
}: {
    message: string;
    /**
     * Present when trying again can help (a failed playback or stream request), as the image viewer offers Retry.
     */
    onRetry?: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.center} testID="agent-chat-video-player-error">
            <Text style={[styles.message, { color: theme.onScrim }]}>{message}</Text>
            {onRetry ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={[styles.retry, { backgroundColor: theme.elevated }]}
                    testID="agent-chat-video-player-retry"
                >
                    <Text style={[styles.retryText, { color: theme.text }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * Plays a stream URL or a local file URI with the platform's own controls (play, pause, and the scrubber). A playback
 * that fails, such as a codec the phone cannot decode, replaces the picture with a message.
 */
export const StreamPlayer = ({
    onRetry,
    theme,
    url,
}: {
    onRetry: () => void;
    theme: MobileTheme;
    url: string;
}) => {
    const { t } = useTranslation();
    const player = useVideoPlayer(url, (created) => {
        created.play();
    });
    const { status } = useEvent(player, 'statusChange', { status: player.status });
    if (status === 'error')
        return (
            <PlayerMessage message={t('chat.video.playFailed')} onRetry={onRetry} theme={theme} />
        );
    return (
        <VideoView
            allowsPictureInPicture={false}
            contentFit="contain"
            nativeControls
            player={player}
            style={styles.fill}
            testID="agent-chat-video-player-view"
        />
    );
};

const styles = StyleSheet.create({
    backdrop: { flex: 1 },
    center: {
        alignItems: 'center',
        gap: mobileSpace.sm,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    fill: { flex: 1 },
    message: {
        ...mobileType.body,
        paddingHorizontal: mobileSpace.xl,
        textAlign: 'center',
    },
    retry: {
        borderRadius: mobileRadius.md,
        justifyContent: 'center',
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    retryText: { ...mobileType.bodyStrong },
    close: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        height: mobileControl.row,
        justifyContent: 'center',
        position: 'absolute',
        right: mobileSpace.lg,
        width: mobileControl.row,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
