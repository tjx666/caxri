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
 * left rather than holding it still on screen first. It also keeps its own closing flag in a shared value rather than
 * React state: committing even that one re-render on Android stalled the slide for about 140 ms after its first frames.
 * A close the owner makes itself (`isOpen` turning false) slides out the same way; `onExited` follows either once the
 * drawer is off screen.
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
    const closing = useSharedValue(false);
    const exited = useEffectEvent(() => onExited());
    useEffect(() => {
        if (isOpen) closing.set(false);
        progress.set(
            withTiming(isOpen ? 1 : 0, { duration: durationMs }, (finished) => {
                if (finished && !isOpen) scheduleOnRN(exited);
            }),
        );
    }, [closing, durationMs, isOpen, progress]);
    const close = (): void => {
        if (closing.get()) return;
        closing.set(true);
        progress.set(
            withTiming(0, { duration: durationMs }, (finished) => {
                if (finished) scheduleOnRN(onClose);
            }),
        );
    };
    /**
     * A leaving drawer and its scrim let touches through to the Session.
     */
    const pointerEvents = (): 'auto' | 'none' => {
        'worklet';
        return isOpen && !closing.get() ? 'auto' : 'none';
    };
    const drawerStyle = useAnimatedStyle(() => ({
        pointerEvents: pointerEvents(),
        transform: [{ translateX: (1 - progress.get()) * width }],
    }));
    const scrimStyle = useAnimatedStyle(() => ({
        opacity: progress.get(),
        pointerEvents: pointerEvents(),
    }));
    return { close, drawerStyle, scrimStyle };
};
