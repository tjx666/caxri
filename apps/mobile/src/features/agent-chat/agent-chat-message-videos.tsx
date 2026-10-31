/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Film, Play, VideoOff, X } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { AgentChatVideoTarget } from './agent-chat-videos';
import { agentChatVideoBlocker } from './agent-chat-videos';
import { useAgentChatVideoPoster, useAgentChatVideoStream } from './use-agent-chat-video';

const CARD_WIDTH = 192;
const CARD_HEIGHT = 108;

const VideoCard = ({
    index,
    onOpen,
    target,
    theme,
}: {
    index: number;
    onOpen: () => void;
    target: AgentChatVideoTarget;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const poster = useAgentChatVideoPoster(target);
    const id = `${target.itemId}-${index}`;
    const name = target.path.slice(target.path.lastIndexOf('/') + 1) || target.path;
    return (
        <Pressable
            accessibilityLabel={t(
                poster.isUnavailable ? 'chat.video.unavailableLabel' : 'chat.video.play',
                { name },
            )}
            accessibilityRole="button"
            accessibilityState={{ disabled: poster.isUnavailable }}
            disabled={poster.isUnavailable}
            onPress={onOpen}
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID={`agent-chat-message-video-${id}`}
        >
            {poster.uri ? (
                <Image
                    resizeMode="cover"
                    source={{ uri: poster.uri }}
                    style={StyleSheet.absoluteFill}
                    testID={`agent-chat-message-video-poster-${id}`}
                />
            ) : null}
            {poster.isUnavailable ? (
                <View style={styles.center} testID={`agent-chat-message-video-unavailable-${id}`}>
                    <VideoOff color={theme.muted} size={22} />
                    <Text style={[styles.unavailable, { color: theme.muted }]}>
                        {t('chat.video.unavailable')}
                    </Text>
                </View>
            ) : (
                <View style={styles.center}>
                    {poster.uri ? null : <Film color={theme.muted} size={22} />}
                    <View style={[styles.play, { backgroundColor: theme.scrimControl }]}>
                        <Play color={theme.onScrim} fill={theme.onScrim} size={16} />
                    </View>
                </View>
            )}
            <Text
                numberOfLines={1}
                style={[styles.name, { backgroundColor: theme.scrimControl, color: theme.onScrim }]}
            >
                {name}
            </Text>
        </Pressable>
    );
};

/**
 * The videos a user message cites, as cards right-aligned above its text like the message's images and like Desktop's
 * video tiles. A card shows the poster frame the computer drew, its file name, and a play button; a tap opens the
 * full-screen player. A deleted file reads as unavailable and cannot be opened.
 */
export const AgentChatMessageVideos = ({
    itemId,
    paths,
    terminalId,
    theme,
}: {
    itemId: string;
    paths: readonly string[];
    terminalId: string;
    theme: MobileTheme;
}) => {
    const [playing, setPlaying] = useState<string | null>(null);
    return (
        <View style={styles.strip} testID={`agent-chat-message-videos-${itemId}`}>
            {paths.map((path, index) => (
                <VideoCard
                    index={index}
                    key={path}
                    onOpen={() => setPlaying(path)}
                    target={{ terminalId, itemId, path }}
                    theme={theme}
                />
            ))}
            <Modal
                animationType="fade"
                onRequestClose={() => setPlaying(null)}
                statusBarTranslucent
                transparent
                visible={playing !== null}
            >
                {playing === null ? null : (
                    <VideoPlayerScreen
                        onClose={() => setPlaying(null)}
                        target={{ terminalId, itemId, path: playing }}
                        theme={theme}
                    />
                )}
            </Modal>
        </View>
    );
};

/**
 * The full-screen player. It asks for the stream only once opened, and says why it cannot play: offline, over the
 * Relay, the file deleted since the card loaded, or a failed playback. Closing it leaves the conversation where it
 * was.
 */
const VideoPlayerScreen = ({
    onClose,
    target,
    theme,
}: {
    onClose: () => void;
    target: AgentChatVideoTarget;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { route, status } = useMobileClient();
    const blocker = agentChatVideoBlocker({ route, status }, t);
    const stream = useAgentChatVideoStream(target, blocker === null);
    // Once the stream started, it plays over its own HTTP connection, so a dropped gateway connection leaves it alone.
    const message = stream.url
        ? null
        : (blocker ??
          (stream.isMissing
              ? t('chat.video.unavailable')
              : stream.isError
                ? t('chat.video.playFailed')
                : null));
    return (
        <View
            style={[styles.backdrop, { backgroundColor: theme.scrim }]}
            testID="agent-chat-video-player"
        >
            {message ? (
                <PlayerMessage message={message} theme={theme} />
            ) : stream.url ? (
                <StreamPlayer theme={theme} url={stream.url} />
            ) : (
                <View style={styles.center}>
                    <Spinner color={theme.onScrim} size={36} />
                </View>
            )}
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

const PlayerMessage = ({ message, theme }: { message: string; theme: MobileTheme }) => (
    <View style={styles.center} testID="agent-chat-video-player-error">
        <Text style={[styles.message, { color: theme.onScrim }]}>{message}</Text>
    </View>
);

/**
 * Plays the stream with the platform's own controls (play, pause, and the scrubber), which seek through range requests.
 * A playback that fails, such as a codec the phone cannot decode, replaces the picture with a message.
 */
const StreamPlayer = ({ theme, url }: { theme: MobileTheme; url: string }) => {
    const { t } = useTranslation();
    const player = useVideoPlayer(url, (created) => {
        created.play();
    });
    const { status } = useEvent(player, 'statusChange', { status: player.status });
    if (status === 'error')
        return <PlayerMessage message={t('chat.video.playFailed')} theme={theme} />;
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
    strip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        justifyContent: 'flex-end',
    },
    card: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: CARD_HEIGHT,
        overflow: 'hidden',
        width: CARD_WIDTH,
    },
    center: {
        alignItems: 'center',
        gap: mobileSpace.sm,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    play: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    unavailable: { ...mobileType.meta },
    name: {
        ...mobileType.meta,
        bottom: 0,
        left: 0,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: 2,
        position: 'absolute',
        right: 0,
    },
    backdrop: { flex: 1 },
    fill: { flex: 1 },
    message: {
        ...mobileType.body,
        paddingHorizontal: mobileSpace.xl,
        textAlign: 'center',
    },
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
