/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';

/**
 * A quiet glyph that names itself on tap, the phone's stand-in for the tooltip Desktop shows on hover (the steered ↳,
 * the sending clock). The hint is also the glyph's accessible name, so a screen reader hears it without the tap.
 */
export const AgentChatHintMark = ({
    accessibilityRole = 'image',
    children,
    hint,
    testID,
    theme,
}: {
    accessibilityRole?: 'image' | 'text';
    children: ReactNode;
    hint: string;
    testID?: string;
    theme: MobileTheme;
}) => {
    const [isShown, setIsShown] = useState(false);
    return (
        <Pressable
            accessibilityLabel={hint}
            accessibilityRole={accessibilityRole}
            hitSlop={8}
            onPress={() => setIsShown((value) => !value)}
            style={styles.root}
            testID={testID}
        >
            {isShown ? (
                <Text numberOfLines={2} style={[styles.hint, { color: theme.muted }]}>
                    {hint}
                </Text>
            ) : null}
            {children}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    root: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    hint: { flexShrink: 1, fontSize: 11, lineHeight: 16 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
