/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType, ReactElement } from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { LayoutChangeEvent, StyleProp, TextStyle, ViewProps, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import MaskedViewClass from '@react-native-masked-view/masked-view';

import {
    SHIMMER_GRADIENT_SCALE,
    SHIMMER_GRADIENT_STOPS,
    SHIMMER_SWEEP_MS,
    shimmerGradientOffset,
} from './shimmer-text-geometry';

/**
 * The package's declaration builds its class from `ReactNative.NativeMethods`, which React Native 0.88 no longer
 * exports, so TypeScript can no longer treat the class as a JSX component. 0.3.2 is the latest release and Expo SDK
 * 58's pin; the runtime component is unchanged, so only its props are restated here.
 * https://github.com/callstack/masked-view/blob/master/types/index.d.ts
 */
const MaskedView = MaskedViewClass as unknown as ComponentType<
    ViewProps & { maskElement: ReactElement }
>;

interface TextSize {
    height: number;
    width: number;
}

/**
 * Live one-line text with a highlight sweeping across it, the phone's form of Desktop's `.activity-shimmer`: running
 * work keeps its glyph and marks progress on its words instead of swapping in a spinner. The resting text renders
 * normally; over it, a real linear gradient of the highlight color slides inside a mask cut from an identical copy of
 * the line, so the band fades per pixel instead of in visible steps and never paints outside the glyphs. The text stays
 * one line and ellipsizes like any label. Reduced motion leaves the text static, and the loop stops when the text
 * unmounts.
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
    // SVG references the gradient by id; React's ids contain colons, which `url(#...)` does not accept.
    const gradientId = `shimmer${useId().replaceAll(/[^\w-]/g, '')}`;
    /**
     * The measured text while the band runs; `null` before the first layout and under reduced motion.
     */
    const bandSize = !isReducedMotion && size !== null && size.width > 0 ? size : null;
    const bandWidth = bandSize?.width ?? 0;
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
    const gradientStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: shimmerGradientOffset(progress.get(), bandWidth) }],
    }));
    const onLayout = useCallback((event: LayoutChangeEvent): void => {
        const { height, width } = event.nativeEvent.layout;
        setSize((current) =>
            current?.height === height && current.width === width ? current : { height, width },
        );
    }, []);
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
                <MaskedView
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    maskElement={
                        // The mask is the same line at the measured width, so its glyphs land exactly on the text's.
                        <Text
                            numberOfLines={1}
                            style={[textStyle, styles.mask, { width: bandSize.width }]}
                        >
                            {children}
                        </Text>
                    }
                    pointerEvents="none"
                    style={StyleSheet.absoluteFill}
                >
                    <Animated.View
                        style={[
                            {
                                height: bandSize.height,
                                width: bandSize.width * SHIMMER_GRADIENT_SCALE,
                            },
                            gradientStyle,
                        ]}
                    >
                        <Svg height="100%" width="100%">
                            <Defs>
                                <LinearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
                                    {SHIMMER_GRADIENT_STOPS.map((stop) => (
                                        <Stop
                                            key={stop.offset}
                                            offset={stop.offset}
                                            stopColor={highlightColor}
                                            stopOpacity={stop.opacity}
                                        />
                                    ))}
                                </LinearGradient>
                            </Defs>
                            <Rect fill={`url(#${gradientId})`} height="100%" width="100%" />
                        </Svg>
                    </Animated.View>
                </MaskedView>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * Any opaque color: a mask uses only the glyphs' alpha.
     */
    mask: { color: '#000' },
    /**
     * Sizes the text to its words (up to the space it gets), so the band sweeps the label rather than empty row space.
     */
    root: { alignItems: 'flex-start', flexShrink: 1, minWidth: 0 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
