/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Film, Play, VideoOff } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { PlayerMessage, StreamPlayer, VideoPlayerFrame } from './agent-chat-video-player';
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
 * The videos a user message cites, as cards under its text inside the bubble like the message's images and like
 * Desktop's video tiles. A card shows the poster frame the computer drew, its file name, and a play button; a tap opens
 * the full-screen player. A deleted file reads as unavailable and cannot be opened.
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
    const { route, status } = useMobileClient();
    const blocker = agentChatVideoBlocker({ route, status }, t);
    const stream = useAgentChatVideoStream(target, blocker === null);
    // Remounts the player on Retry, since a failed playback keeps the same stream URL.
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
        setAttempt((count) => count + 1);
        stream.retry();
    };
    // Once the stream started, it plays over its own HTTP connection, so a dropped gateway connection leaves it alone.
    const message = stream.url
        ? null
        : (blocker ??
          (stream.isMissing
              ? t('chat.video.unavailable')
              : stream.isError
                ? t('chat.video.playFailed')
                : null));
    const canRetry = stream.isError && !stream.isMissing && blocker === null && !stream.url;
    return (
        <VideoPlayerFrame onClose={onClose} theme={theme}>
            {message ? (
                <PlayerMessage
                    message={message}
                    onRetry={canRetry ? retry : undefined}
                    theme={theme}
                />
            ) : stream.url ? (
                <StreamPlayer key={attempt} onRetry={retry} theme={theme} url={stream.url} />
            ) : (
                <View style={styles.center}>
                    <Spinner color={theme.onScrim} size={36} />
                </View>
            )}
        </VideoPlayerFrame>
    );
};

const styles = StyleSheet.create({
    strip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        justifyContent: 'flex-start',
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
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
