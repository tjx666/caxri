/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { X } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatImageTarget } from './agent-chat-images';
import { useAgentChatImage } from './use-agent-chat-image';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch, pan, and double-tap zoom over one image, after Paseo's zoomable viewport (Apache-2.0). Zoom never goes below
 * the fitted size, and returning to it recenters the picture.
 */
const ZoomableImage = ({ uri }: { uri: string }) => {
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const savedX = useSharedValue(0);
    const savedY = useSharedValue(0);
    const reset = () => {
        'worklet';
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
    };
    const pinch = Gesture.Pinch()
        .onUpdate((event) => {
            scale.value = Math.min(MAX_SCALE, Math.max(0.8, savedScale.value * event.scale));
        })
        .onEnd(() => {
            if (scale.value <= MIN_SCALE) reset();
            else savedScale.value = scale.value;
        });
    const pan = Gesture.Pan()
        .minPointers(1)
        .onUpdate((event) => {
            if (savedScale.value <= MIN_SCALE && scale.value <= MIN_SCALE) return;
            translateX.value = savedX.value + event.translationX;
            translateY.value = savedY.value + event.translationY;
        })
        .onEnd(() => {
            savedX.value = translateX.value;
            savedY.value = translateY.value;
        });
    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (savedScale.value > MIN_SCALE) reset();
            else {
                scale.value = withTiming(DOUBLE_TAP_SCALE);
                savedScale.value = DOUBLE_TAP_SCALE;
            }
        });
    const style = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: scale.value },
        ],
    }));
    return (
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
            <Animated.View collapsable={false} style={[styles.fill, style]}>
                <Image
                    accessibilityIgnoresInvertColors
                    accessibilityLabel="Full-size image"
                    resizeMode="contain"
                    source={{ uri }}
                    style={styles.fill}
                    testID="agent-chat-image-viewer-image"
                />
            </Animated.View>
        </GestureDetector>
    );
};

/**
 * A message image at full size over a black backdrop. The original is read from the provider's record on open, so the
 * viewer shows its progress, and says so when the record no longer has the image.
 */
export const AgentChatImageViewer = ({
    onClose,
    target,
    theme,
}: {
    onClose: () => void;
    /**
     * The image to show; `null` keeps the viewer closed.
     */
    target: Omit<AgentChatImageTarget, 'variant'> | null;
    theme: MobileTheme;
}) => (
    <Modal
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
        transparent
        visible={target !== null}
    >
        {target ? <ViewerContent onClose={onClose} target={target} theme={theme} /> : null}
    </Modal>
);

const ViewerContent = ({
    onClose,
    target,
    theme,
}: {
    onClose: () => void;
    target: Omit<AgentChatImageTarget, 'variant'>;
    theme: MobileTheme;
}) => {
    const insets = useSafeAreaInsets();
    const original = useAgentChatImage({ ...target, variant: 'original' });
    const message = original.isMissing
        ? 'This image is no longer available.'
        : original.isError
          ? 'The image could not be loaded.'
          : null;
    return (
        <GestureHandlerRootView style={styles.backdrop} testID="agent-chat-image-viewer">
            {original.uri ? <ZoomableImage uri={original.uri} /> : null}
            {original.isLoading ? (
                <View style={styles.center}>
                    <ActivityIndicator color="#fff" size="large" />
                    <Text style={styles.status}>{Math.round(original.progress * 100)}%</Text>
                </View>
            ) : null}
            {message ? (
                <View style={styles.center} testID="agent-chat-image-viewer-error">
                    <Text style={styles.status}>{message}</Text>
                    {original.isError ? (
                        <Pressable
                            accessibilityRole="button"
                            onPress={original.retry}
                            style={[styles.retry, { backgroundColor: theme.elevated }]}
                            testID="agent-chat-image-viewer-retry"
                        >
                            <Text style={[styles.retryText, { color: theme.text }]}>Retry</Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            <Pressable
                accessibilityLabel="Close image"
                accessibilityRole="button"
                hitSlop={12}
                onPress={onClose}
                style={[styles.close, { top: insets.top + 12 }]}
                testID="agent-chat-image-viewer-close"
            >
                <X color="#fff" size={22} strokeWidth={2.5} />
            </Pressable>
        </GestureHandlerRootView>
    );
};

const styles = StyleSheet.create({
    backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.94)', flex: 1 },
    fill: { flex: 1, height: '100%', width: '100%' },
    center: {
        alignItems: 'center',
        gap: 12,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    status: { color: '#fff', fontSize: 15, fontVariant: ['tabular-nums'], textAlign: 'center' },
    retry: { borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
    retryText: { fontSize: 15, fontWeight: '600' },
    close: {
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.16)',
        borderRadius: 20,
        height: 40,
        justifyContent: 'center',
        position: 'absolute',
        right: 16,
        width: 40,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
