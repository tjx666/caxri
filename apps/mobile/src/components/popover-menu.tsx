/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import type { MobileTheme } from '../theme/tokens';
import type { PopoverPlacement } from './use-popover-anchor';

/**
 * A small menu anchored under a control. Any tap outside it, or Android Back, closes it without reaching the content
 * underneath, matching platform overflow menus.
 */
export const PopoverMenu = ({
    children,
    closeLabel,
    onClose,
    placement,
    theme,
}: {
    children: ReactNode;
    closeLabel: string;
    onClose: () => void;
    placement: PopoverPlacement | null;
    theme: MobileTheme;
}) =>
    placement ? (
        <Modal
            animationType="none"
            navigationBarTranslucent
            onRequestClose={onClose}
            statusBarTranslucent
            transparent
            visible
        >
            <Pressable
                accessibilityLabel={closeLabel}
                accessibilityRole="button"
                onPress={onClose}
                style={StyleSheet.absoluteFill}
            />
            <Animated.View
                entering={FadeIn.duration(140)}
                style={[
                    styles.menu,
                    {
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                        right: placement.right,
                        top: placement.top,
                    },
                ]}
            >
                {children}
            </Animated.View>
        </Modal>
    ) : null;

const styles = StyleSheet.create({
    menu: {
        borderRadius: 12,
        borderWidth: 1,
        boxShadow: '0px 6px 16px rgba(0, 0, 0, 0.4)',
        minWidth: 200,
        paddingVertical: 4,
        position: 'absolute',
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
