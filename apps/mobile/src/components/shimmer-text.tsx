/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LayoutChangeEvent, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { SHIMMER_SWEEP_MS, shimmerBandLayers, shimmerWindowOffset } from './shimmer-text-geometry';

interface TextSize {
    height: number;
    width: number;
}

/**
 * One window of the band: a clip that slides with the peak over a copy of the text in the highlight color, which slides
 * back by the same amount so its glyphs stay over the resting text.
 */
const ShimmerBand = ({
    color,
    halfWidth,
    opacity,
    progress,
    size,
    text,
    textStyle,
}: {
    color: string;
    halfWidth: number;
    opacity: number;
    progress: SharedValue<number>;
    size: TextSize;
    text: string;
    textStyle: StyleProp<TextStyle>;
}) => {
    const { height, width } = size;
    const windowStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: shimmerWindowOffset(progress.get(), width, halfWidth) }],
    }));
    const copyStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: -shimmerWindowOffset(progress.get(), width, halfWidth) }],
    }));
    return (
        <Animated.View
            style={[styles.window, { height, opacity, width: halfWidth * 2 }, windowStyle]}
        >
            <Animated.View style={[{ height, width }, copyStyle]}>
                <Text numberOfLines={1} style={[textStyle, { color, width }]}>
                    {text}
                </Text>
            </Animated.View>
        </Animated.View>
    );
};

/**
 * Live one-line text with a highlight sweeping across it, the phone's form of Desktop's `.activity-shimmer`: running
 * work keeps its glyph and marks progress on its words instead of swapping in a spinner. The text stays one line and
 * ellipsizes like any label; the band paints exact copies of that line, so it never reveals clipped text. Reduced
 * motion leaves the text static, and the loop stops when the text unmounts.
 */
export const ShimmerText = ({
    children,
    color,
    highlightColor,
    style,
    testID,
    textStyle,
}: {
    children: string;
    /**
     * The resting color, as Desktop keeps the element's own color at both ends of the sweep.
     */
    color: string;
    highlightColor: string;
    /**
     * The container's layout in its row, such as `flex: 1` to push trailing facts to the edge.
     */
    style?: StyleProp<ViewStyle>;
    testID?: string;
    textStyle?: StyleProp<TextStyle>;
}) => {
    const isReducedMotion = useReducedMotion();
    const [size, setSize] = useState<TextSize | null>(null);
    const progress = useSharedValue(0);
    /**
     * The measured text while the band runs; `null` before the first layout and under reduced motion.
     */
    const bandSize = !isReducedMotion && size !== null && size.width > 0 ? size : null;
    const isAnimated = bandSize !== null;
    useEffect(() => {
        if (!isAnimated) return;
        progress.set(0);
        progress.set(
            withRepeat(
                withTiming(1, { duration: SHIMMER_SWEEP_MS, easing: Easing.linear }),
                -1,
                false,
            ),
        );
        return () => cancelAnimation(progress);
    }, [isAnimated, progress]);
    const onLayout = useCallback((event: LayoutChangeEvent): void => {
        const { height, width } = event.nativeEvent.layout;
        setSize((current) =>
            current?.height === height && current.width === width ? current : { height, width },
        );
    }, []);
    const layers = useMemo(() => (size ? shimmerBandLayers(size.width) : []), [size]);
    return (
        <View style={[styles.root, style]}>
            <Text
                numberOfLines={1}
                onLayout={onLayout}
                style={[textStyle, { color }]}
                testID={testID}
            >
                {children}
            </Text>
            {bandSize ? (
                <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    pointerEvents="none"
                    style={StyleSheet.absoluteFill}
                >
                    {layers.map((layer) => (
                        <ShimmerBand
                            color={highlightColor}
                            halfWidth={layer.halfWidth}
                            key={layer.halfWidth}
                            opacity={layer.opacity}
                            progress={progress}
                            size={bandSize}
                            text={children}
                            textStyle={textStyle}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * Sizes the text to its words (up to the space it gets), so the band sweeps the label rather than empty row space.
     */
    root: { alignItems: 'flex-start', flexShrink: 1, minWidth: 0 },
    window: { left: 0, overflow: 'hidden', position: 'absolute', top: 0 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
