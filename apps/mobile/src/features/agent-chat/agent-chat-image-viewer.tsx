/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { X } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatImageTarget } from './agent-chat-images';
import { agentChatViewerContent, clampZoomPan } from './agent-chat-images';
import { useAgentChatImage } from './use-agent-chat-image';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch, pan, and double-tap zoom over one image, after Paseo's zoomable viewport (Apache-2.0). Zoom never goes below
 * the fitted size, returning to it recenters the picture, and a pan stops at the zoomed picture's edges so it can never
 * be dragged off screen.
 */
const ZoomableImage = ({
    accessibilityLabel,
    uri,
}: {
    accessibilityLabel: string;
    uri: string;
}) => {
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const savedX = useSharedValue(0);
    const savedY = useSharedValue(0);
    const width = useSharedValue(0);
    const height = useSharedValue(0);
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
            if (scale.value <= MIN_SCALE) {
                reset();
                return;
            }
            savedScale.value = scale.value;
            // Zooming out shrinks the room to pan, so a picture panned to an edge is pulled back inside it.
            savedX.value = clampZoomPan(translateX.value, scale.value, width.value);
            savedY.value = clampZoomPan(translateY.value, scale.value, height.value);
            translateX.value = withTiming(savedX.value);
            translateY.value = withTiming(savedY.value);
        });
    const pan = Gesture.Pan()
        .maxPointers(1)
        .onUpdate((event) => {
            if (savedScale.value <= MIN_SCALE) return;
            translateX.value = clampZoomPan(
                savedX.value + event.translationX,
                scale.value,
                width.value,
            );
            translateY.value = clampZoomPan(
                savedY.value + event.translationY,
                scale.value,
                height.value,
            );
        })
        .onEnd(() => {
            savedX.value = translateX.value;
            savedY.value = translateY.value;
        });
    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd((_event, isSuccess) => {
            if (!isSuccess) return;
            if (savedScale.value > MIN_SCALE) reset();
            else {
                scale.value = withTiming(DOUBLE_TAP_SCALE);
                savedScale.value = DOUBLE_TAP_SCALE;
            }
        });
    // As in Paseo's viewport, a drag or pinch wins over the double tap instead of all three racing for one touch.
    const gesture = Gesture.Exclusive(Gesture.Simultaneous(pan, pinch), doubleTap);
    const style = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: scale.value },
        ],
    }));
    return (
        <GestureDetector gesture={gesture}>
            <Animated.View
                collapsable={false}
                onLayout={(event) => {
                    width.value = event.nativeEvent.layout.width;
                    height.value = event.nativeEvent.layout.height;
                }}
                style={[styles.fill, style]}
            >
                <Image
                    accessibilityHint="Pinch or double-tap to zoom."
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={accessibilityLabel}
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
    // Already loaded by the message strip; it stands in while the original loads, and when the provider's record has
    // no original (Codex).
    const thumbnail = useAgentChatImage({ ...target, variant: 'thumbnail' });
    const content = agentChatViewerContent(original, thumbnail.uri);
    const position = `image ${target.index + 1} of this message`;
    return (
        <GestureHandlerRootView style={styles.backdrop} testID="agent-chat-image-viewer">
            {content.placeholderUri ? (
                <Image
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={`Preview of ${position}`}
                    resizeMode="contain"
                    source={{ uri: content.placeholderUri }}
                    style={[styles.fill, styles.placeholder]}
                    testID="agent-chat-image-viewer-placeholder"
                />
            ) : null}
            {content.imageUri ? (
                <ZoomableImage
                    accessibilityLabel={
                        content.isPreview ? `Preview of ${position}` : `Full size ${position}`
                    }
                    uri={content.imageUri}
                />
            ) : null}
            {content.isPreview ? (
                <Text
                    style={[styles.note, { bottom: insets.bottom + 24 }]}
                    testID="agent-chat-image-viewer-preview-note"
                >
                    Showing a preview. The full-size image is not available.
                </Text>
            ) : null}
            {original.isLoading ? (
                <View style={styles.center}>
                    <ActivityIndicator color="#fff" size="large" />
                    <Text style={styles.status}>{Math.round(original.progress * 100)}%</Text>
                </View>
            ) : null}
            {content.message ? (
                <View style={styles.center} testID="agent-chat-image-viewer-error">
                    <Text style={styles.status}>{content.message}</Text>
                    {original.isError ? (
                        <Pressable
                            accessibilityHint="Loads the full-size image again."
                            accessibilityLabel="Retry loading the image"
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
    /**
     * The thumbnail is a fraction of the original's resolution, so it is dimmed while it stands in for it.
     */
    placeholder: { opacity: 0.6, ...StyleSheet.absoluteFill },
    center: {
        alignItems: 'center',
        gap: 12,
        justifyContent: 'center',
        ...StyleSheet.absoluteFill,
    },
    note: {
        color: 'rgba(255, 255, 255, 0.8)',
        fontSize: 13,
        left: 24,
        position: 'absolute',
        right: 24,
        textAlign: 'center',
    },
    status: { color: '#fff', fontSize: 15, fontVariant: ['tabular-nums'], textAlign: 'center' },
    retry: {
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 18,
    },
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
