/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
/* oxlint-disable typescript/no-deprecated -- Gesture Handler 3 deprecates the `Gesture` builder but still ships it. The
   hook API renames the end callbacks and changes composition, so the viewer moves only with on-device pinch and swipe
   verification. */
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { X } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatImageTarget, AgentChatViewerSwipe } from './agent-chat-images';
import {
    agentChatViewerAccessibility,
    agentChatViewerAccessibilitySwipe,
    agentChatViewerContent,
    agentChatViewerPage,
    agentChatViewerPosition,
    agentChatViewerSwipe,
    clampZoomPan,
} from './agent-chat-images';
import { useAgentChatImage } from './use-agent-chat-image';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch, pan, and double-tap zoom over one image, after Paseo's zoomable viewport (Apache-2.0). Zoom never goes below
 * the fitted size, returning to it recenters the picture, and a pan stops at the zoomed picture's edges so it can never
 * be dragged off screen. At the fitted size the same one-finger drag closes the viewer (down) or turns to the message's
 * next or previous image (sideways, `agentChatViewerSwipe`); the picture follows the finger and springs back when the
 * drag falls short or there is no image that way. A zoomed picture only pans, so the gestures never conflict.
 */
const ZoomableImage = ({
    accessibilityLabel,
    canTurnTo,
    onSwipe,
    uri,
}: {
    accessibilityLabel: string;
    /**
     * Whether the message has an image before and after this one.
     */
    canTurnTo: { next: boolean; previous: boolean };
    onSwipe: (swipe: AgentChatViewerSwipe) => void;
    uri: string;
}) => {
    const { t } = useTranslation();
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
            if (savedScale.value <= MIN_SCALE) {
                // The fitted picture follows a drag along its main axis only, and only down for closing.
                const isVertical = Math.abs(event.translationY) > Math.abs(event.translationX);
                translateX.value = isVertical ? 0 : event.translationX;
                translateY.value = isVertical ? Math.max(0, event.translationY) : 0;
                return;
            }
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
        .onEnd((event) => {
            if (savedScale.value <= MIN_SCALE) {
                const swipe = agentChatViewerSwipe(event, {
                    width: width.value,
                    height: height.value,
                });
                if (swipe === 'dismiss' || (swipe !== null && canTurnTo[swipe])) {
                    scheduleOnRN(onSwipe, swipe);
                    return;
                }
                translateX.value = withTiming(0);
                translateY.value = withTiming(0);
                return;
            }
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
    const a11y = agentChatViewerAccessibility(canTurnTo, t);
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
                    accessibilityActions={a11y.actions}
                    accessibilityHint={a11y.hint}
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={accessibilityLabel}
                    accessibilityRole={a11y.role}
                    onAccessibilityAction={({ nativeEvent }) => {
                        const swipe = agentChatViewerAccessibilitySwipe(nativeEvent.actionName);
                        if (swipe !== null && canTurnTo[swipe]) onSwipe(swipe);
                    }}
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
 * Pages and closes the viewer while there is no picture to zoom yet (the original still loading, or missing), with the
 * same swipes as a fitted picture.
 */
const SwipeArea = ({
    canTurnTo,
    onSwipe,
}: {
    canTurnTo: { next: boolean; previous: boolean };
    onSwipe: (swipe: AgentChatViewerSwipe) => void;
}) => {
    const width = useSharedValue(0);
    const height = useSharedValue(0);
    const pan = Gesture.Pan()
        .maxPointers(1)
        .onEnd((event) => {
            const swipe = agentChatViewerSwipe(event, { width: width.value, height: height.value });
            if (swipe === 'dismiss' || (swipe !== null && canTurnTo[swipe]))
                scheduleOnRN(onSwipe, swipe);
        });
    return (
        <GestureDetector gesture={pan}>
            <View
                collapsable={false}
                onLayout={(event) => {
                    width.value = event.nativeEvent.layout.width;
                    height.value = event.nativeEvent.layout.height;
                }}
                style={StyleSheet.absoluteFill}
            />
        </GestureDetector>
    );
};

/**
 * A message image at full size over a black backdrop. The original is read from the provider's record on open, so the
 * viewer shows its progress, and says so when the record no longer has the image. A message with several images pages
 * through them with a sideways swipe under a `2 / 3` counter; a downward swipe closes the viewer.
 */
export const AgentChatImageViewer = ({
    count,
    onClose,
    target,
    theme,
}: {
    /**
     * How many images the message carries.
     */
    count: number;
    onClose: () => void;
    /**
     * The image opened first; `null` keeps the viewer closed.
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
        {target ? (
            <ViewerPager count={count} onClose={onClose} start={target} theme={theme} />
        ) : null}
    </Modal>
);

/**
 * Keeps which image of the message is shown. Each page is its own `ViewerContent`, so turning the page starts the next
 * image at its fitted size.
 */
const ViewerPager = ({
    count,
    onClose,
    start,
    theme,
}: {
    count: number;
    onClose: () => void;
    start: Omit<AgentChatImageTarget, 'variant'>;
    theme: MobileTheme;
}) => {
    const [index, setIndex] = useState(start.index);
    const onSwipe = (swipe: AgentChatViewerSwipe): void => {
        if (swipe === 'dismiss') {
            onClose();
            return;
        }
        const next = agentChatViewerPage(index, count, swipe);
        if (next !== null) setIndex(next);
    };
    return (
        <ViewerContent
            canTurnTo={{ next: index < count - 1, previous: index > 0 }}
            key={index}
            onClose={onClose}
            onSwipe={onSwipe}
            position={agentChatViewerPosition(index, count)}
            target={{ ...start, index }}
            theme={theme}
        />
    );
};

const ViewerContent = ({
    canTurnTo,
    onClose,
    onSwipe,
    position: counter,
    target,
    theme,
}: {
    canTurnTo: { next: boolean; previous: boolean };
    onClose: () => void;
    onSwipe: (swipe: AgentChatViewerSwipe) => void;
    /**
     * The `2 / 3` counter, or `null` for a message with one image.
     */
    position: string | null;
    target: Omit<AgentChatImageTarget, 'variant'>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const original = useAgentChatImage({ ...target, variant: 'original' });
    // Already loaded by the message strip; it stands in while the original loads, and when the provider's record has
    // no original (Codex).
    const thumbnail = useAgentChatImage({ ...target, variant: 'thumbnail' });
    const content = agentChatViewerContent(original, thumbnail.uri, t);
    const number = target.index + 1;
    return (
        <GestureHandlerRootView
            style={[styles.backdrop, { backgroundColor: theme.scrim }]}
            testID="agent-chat-image-viewer"
        >
            {content.placeholderUri ? (
                <Image
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={t('chat.image.preview', { number })}
                    resizeMode="contain"
                    source={{ uri: content.placeholderUri }}
                    style={[styles.fill, styles.placeholder]}
                    testID="agent-chat-image-viewer-placeholder"
                />
            ) : null}
            {content.imageUri ? (
                <ZoomableImage
                    accessibilityLabel={t(
                        content.isPreview ? 'chat.image.preview' : 'chat.image.fullSize',
                        { number },
                    )}
                    canTurnTo={canTurnTo}
                    onSwipe={onSwipe}
                    uri={content.imageUri}
                />
            ) : (
                <SwipeArea canTurnTo={canTurnTo} onSwipe={onSwipe} />
            )}
            {content.isPreview ? (
                <Text
                    style={[styles.note, { bottom: insets.bottom + 24, color: theme.onScrimMuted }]}
                    testID="agent-chat-image-viewer-preview-note"
                >
                    {t('chat.image.previewNote')}
                </Text>
            ) : null}
            {original.isLoading ? (
                <View pointerEvents="none" style={styles.center}>
                    <Spinner color={theme.onScrim} size={36} />
                    <Text style={[styles.status, { color: theme.onScrim }]}>
                        {Math.round(original.progress * 100)}%
                    </Text>
                </View>
            ) : null}
            {content.message ? (
                <View
                    pointerEvents="box-none"
                    style={styles.center}
                    testID="agent-chat-image-viewer-error"
                >
                    <Text style={[styles.status, { color: theme.onScrim }]}>{content.message}</Text>
                    {original.isError ? (
                        <Pressable
                            accessibilityHint={t('chat.image.retryHint')}
                            accessibilityLabel={t('chat.image.retryLabel')}
                            accessibilityRole="button"
                            onPress={original.retry}
                            style={[styles.retry, { backgroundColor: theme.elevated }]}
                            testID="agent-chat-image-viewer-retry"
                        >
                            <Text style={[styles.retryText, { color: theme.text }]}>
                                {t('common.retry')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            {counter ? (
                <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.counter, { color: theme.onScrim, top: insets.top + 22 }]}
                    testID="agent-chat-image-viewer-position"
                >
                    {counter}
                </Text>
            ) : null}
            <Pressable
                accessibilityLabel={t('chat.image.close')}
                accessibilityRole="button"
                hitSlop={12}
                onPress={onClose}
                style={[
                    styles.close,
                    { backgroundColor: theme.scrimControl, top: insets.top + 12 },
                ]}
                testID="agent-chat-image-viewer-close"
            >
                <X color={theme.onScrim} size={22} strokeWidth={2.5} />
            </Pressable>
        </GestureHandlerRootView>
    );
};

const styles = StyleSheet.create({
    backdrop: { flex: 1 },
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
        fontSize: 13,
        left: 24,
        position: 'absolute',
        right: 24,
        textAlign: 'center',
    },
    counter: {
        fontSize: 15,
        fontVariant: ['tabular-nums'],
        fontWeight: '600',
        left: 72,
        position: 'absolute',
        right: 72,
        textAlign: 'center',
    },
    status: { fontSize: 15, fontVariant: ['tabular-nums'], textAlign: 'center' },
    retry: {
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 18,
    },
    retryText: { fontSize: 15, fontWeight: '600' },
    close: {
        alignItems: 'center',
        borderRadius: 20,
        height: 40,
        justifyContent: 'center',
        position: 'absolute',
        right: 16,
        width: 40,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
