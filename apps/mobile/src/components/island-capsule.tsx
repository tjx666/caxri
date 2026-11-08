/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { mobileRadius, mobileSpace } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';

/**
 * The one floating capsule shell over the top center of the screen, like a Dynamic Island. Session notices that need
 * nothing from the user and the app's toast both draw through it, so every transient message shares one position,
 * shape, elevation, and motion. It takes no layout height; only the capsule itself can take touches, and only when
 * `isInteractive` is set. Motion follows the system's reduce-motion setting.
 */
export const IslandCapsule = ({
    accessibilityLiveRegion,
    children,
    isInteractive,
    testID,
    theme,
    wrapperTestID,
}: {
    accessibilityLiveRegion?: 'none' | 'polite';
    children: ReactNode;
    /**
     * Whether the capsule takes touches. A read-only capsule lets taps through to the header below it.
     */
    isInteractive: boolean;
    testID: string;
    theme: MobileTheme;
    /**
     * An extra id on the floating host, for a fact the capsule carries.
     */
    wrapperTestID?: string;
}) => {
    const insets = useSafeAreaInsets();
    return (
        <View
            collapsable={false}
            pointerEvents="box-none"
            style={[styles.host, { top: insets.top + mobileSpace.xs }]}
            testID={wrapperTestID}
        >
            <Animated.View
                accessibilityLiveRegion={accessibilityLiveRegion}
                entering={FadeInUp.duration(160).reduceMotion(ReduceMotion.System)}
                exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
                pointerEvents={isInteractive ? 'auto' : 'none'}
                style={[
                    styles.capsule,
                    {
                        backgroundColor: theme.elevated,
                        borderColor: theme.border,
                        boxShadow: `0px 2px 8px ${theme.shadow}`,
                    },
                ]}
                testID={testID}
            >
                {children}
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    capsule: {
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        maxWidth: '100%',
    },
    host: {
        alignItems: 'center',
        left: 0,
        paddingHorizontal: mobileSpace.lg,
        position: 'absolute',
        right: 0,
        zIndex: 1,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
