import { useState } from 'react';
import { Modal } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { StreamPlayer, VideoPlayerFrame } from '../../agent-chat/agent-chat-video-player';

/**
 * Plays a video or recording still on the phone, such as a composer attachment, full screen with the same frame as a
 * message's video. It reads the local copy, so it plays whether or not the upload finished.
 */
export const LocalVideoPlayer = ({
    onClose,
    theme,
    uri,
}: {
    onClose: () => void;
    theme: MobileTheme;
    /**
     * The local file to play; `null` keeps the player closed.
     */
    uri: string | null;
}) => {
    // Remounts the player on Retry, since a failed playback keeps the same URI.
    const [attempt, setAttempt] = useState(0);
    return (
        <Modal
            animationType="fade"
            onRequestClose={onClose}
            statusBarTranslucent
            transparent
            visible={uri !== null}
        >
            {uri === null ? null : (
                <VideoPlayerFrame onClose={onClose} theme={theme}>
                    <StreamPlayer
                        key={attempt}
                        onRetry={() => setAttempt((count) => count + 1)}
                        theme={theme}
                        url={uri}
                    />
                </VideoPlayerFrame>
            )}
        </Modal>
    );
};
