import { useEffect, useEffectEvent, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * Keeps a drawer's last shown value mounted after its owner closes it, until the drawer reports that its close
 * animation finished.
 *
 * @returns `shown`, the value to render (the open value, or the last one while it closes), and `onExited`, which the
 *   drawer calls once it is off screen.
 */
export const useDrawerPresence = <T>(open: T | null): { onExited: () => void; shown: T | null } => {
    const [held, setHeld] = useState<T | null>(open);
    if (open !== null && open !== held) setHeld(open);
    return { onExited: () => setHeld(null), shown: open ?? held };
};

/**
 * Slides a drawer in from the right edge over a scrim, and back out on close.
 *
 * The drawer stays mounted while it leaves instead of relying on Reanimated's `exiting` animation: on Android an
 * unmounted view loses its background as soon as React Native drops it, so an `exiting` slide moved only the drawer's
 * text away over the Session, as a transparent ghost, while the scrim vanished in one frame.
 *
 * `close` plays the slide before it calls `onClose`, so the re-render that closing causes runs after the drawer has
 * left rather than holding it still on screen first. A close the owner makes itself (`isOpen` turning false) slides out
 * the same way; `onExited` follows either once the drawer is off screen.
 */
export const useDrawerMotion = ({
    durationMs,
    isOpen,
    onClose,
    onExited,
}: {
    durationMs: number;
    isOpen: boolean;
    onClose: () => void;
    onExited: () => void;
}) => {
    const { width } = useWindowDimensions();
    const progress = useSharedValue(0);
    const [isClosing, setIsClosing] = useState(false);
    const exited = useEffectEvent(() => onExited());
    useEffect(() => {
        progress.set(
            withTiming(isOpen ? 1 : 0, { duration: durationMs }, (finished) => {
                if (finished && !isOpen) scheduleOnRN(exited);
            }),
        );
    }, [durationMs, isOpen, progress]);
    const close = (): void => {
        if (isClosing) return;
        setIsClosing(true);
        progress.set(
            withTiming(0, { duration: durationMs }, (finished) => {
                if (finished) scheduleOnRN(onClose);
            }),
        );
    };
    const drawerStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: (1 - progress.get()) * width }],
    }));
    const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
    return {
        close,
        drawerStyle,
        /**
         * Whether the drawer and its scrim take touches; a leaving drawer lets them through to the Session.
         */
        isInteractive: isOpen && !isClosing,
        scrimStyle,
    };
};
