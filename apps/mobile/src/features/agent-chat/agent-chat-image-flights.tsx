/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ImageStyle, StyleProp } from 'react-native';
import { Image, StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type {
    AgentChatFlightBox,
    AgentChatFlightMeasurable,
    AgentChatImageFlight,
} from './agent-chat-image-flight-store';
import {
    endImageFlight,
    imageFlightsSnapshot,
    isImageFlying,
    landImageFlight,
    measureImageFlightBox,
    subscribeImageFlights,
} from './agent-chat-image-flight-store';

/**
 * Desktop's `--motion-image-send` on its emphasized curve (`--motion-ease-emphasized`).
 */
const FLIGHT_MS = 280;
const FLIGHT_EASING = Easing.bezier(0.25, 1, 0.5, 1);

/**
 * A sent image's tile in the pending message: it reports where it laid out so its flight can land there, and stays
 * hidden while the flight is in the air so the image never shows twice.
 */
export const AgentChatFlightTile = ({
    accessibilityLabel,
    style,
    uri,
}: {
    accessibilityLabel: string;
    style: StyleProp<ImageStyle>;
    uri: string;
}) => {
    const tile = useRef<AgentChatFlightMeasurable | null>(null);
    const isFlying = useSyncExternalStore(subscribeImageFlights, () => isImageFlying(uri));
    return (
        <Image
            accessibilityLabel={accessibilityLabel}
            onLayout={() => {
                const view = tile.current;
                if (!view || !isImageFlying(uri)) return;
                void measureImageFlightBox(view).then((box) => {
                    if (box) landImageFlight(uri, box);
                });
            }}
            ref={(element) => {
                tile.current = element;
            }}
            resizeMode="cover"
            source={{ uri }}
            style={[style, isFlying && styles.hidden]}
        />
    );
};

/**
 * The layer the Session screen draws sent images on while they fly; it covers the screen and never takes a touch. Only
 * the visible Session draws them, so a screen kept mounted behind it does not fly a second copy.
 */
export const AgentChatImageFlights = ({ isVisible }: { isVisible: boolean }) => {
    const flights = useSyncExternalStore(subscribeImageFlights, imageFlightsSnapshot);
    const layer = useRef<AgentChatFlightMeasurable | null>(null);
    /**
     * The layer's own place in the window, since flights are measured in window space.
     */
    const [origin, setOrigin] = useState<{ x: number; y: number }>();
    const landed = flights.filter(
        (flight): flight is AgentChatImageFlight & { to: AgentChatFlightBox } =>
            flight.to !== undefined,
    );
    return (
        <View
            onLayout={() => layer.current?.measureInWindow((x, y) => setOrigin({ x, y }))}
            pointerEvents="none"
            ref={(element) => {
                layer.current = element;
            }}
            style={StyleSheet.absoluteFill}
        >
            {isVisible && origin
                ? landed.map((flight) => (
                      <FlyingImage flight={flight} key={flight.id} origin={origin} />
                  ))
                : null}
        </View>
    );
};

const FlyingImage = ({
    flight: { from, id, to, uri },
    origin,
}: {
    flight: AgentChatImageFlight & { to: AgentChatFlightBox };
    origin: { x: number; y: number };
}) => {
    const progress = useSharedValue(0);
    useEffect(() => {
        progress.set(
            withTiming(
                1,
                { duration: FLIGHT_MS, easing: FLIGHT_EASING, reduceMotion: ReduceMotion.System },
                () => scheduleOnRN(endImageFlight, id),
            ),
        );
    }, [id, progress]);
    const style = useAnimatedStyle(() => {
        const at = progress.get();
        const between = (start: number, end: number): number => start + (end - start) * at;
        return {
            height: between(from.height, to.height),
            left: between(from.x, to.x) - origin.x,
            top: between(from.y, to.y) - origin.y,
            width: between(from.width, to.width),
        };
    });
    return <Animated.Image resizeMode="cover" source={{ uri }} style={[styles.flight, style]} />;
};

const styles = StyleSheet.create({
    flight: { borderRadius: 12, position: 'absolute' },
    hidden: { opacity: 0 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
