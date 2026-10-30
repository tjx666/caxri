/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';

import { mobileRadius, mobileSpace } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';

/**
 * Card emphasis. `attention` is reserved for the one thing that blocks the Agent on the user (a permission request or a
 * question), so exactly one card on screen draws the amber border; `danger` marks a failure the user must act on.
 */
export type CardTone = 'attention' | 'danger' | 'default';

/**
 * The app's one bounded surface: docked Chat panels (plan, goal, queue, request), result cards (pull request, issue,
 * artifact), notices inside the timeline, and the grouped rows of Settings, Agent usage, and Computer status. One
 * radius, one border, and one fill, so siblings never disagree by a few points. A non-default tone colors the border
 * rather than the fill, as Desktop frames a Chat request, so the state never rests on fill color alone. It is not a
 * thicker leading edge: Android draws a 3dp left border under a 12dp radius as a crescent that bends into the top and
 * bottom borders.
 */
export const Card = ({
    accessibilityLabel,
    children,
    padded = true,
    style,
    testID,
    theme,
    tone = 'default',
}: {
    /**
     * Names the card for a screen reader when its content alone does not, such as a docked queue.
     */
    accessibilityLabel?: string;
    children: ReactNode;
    /**
     * Inner padding of `md` (12dp). A card of full-width rows turns it off so each row owns its own inset and divider.
     */
    padded?: boolean;
    /**
     * Layout only (margins, gap). Shape and color come from the card.
     */
    style?: StyleProp<ViewStyle>;
    testID?: string;
    theme: MobileTheme;
    tone?: CardTone;
}) => (
    <View
        accessibilityLabel={accessibilityLabel}
        style={[
            styles.card,
            padded ? styles.padded : null,
            {
                backgroundColor: theme.surface,
                borderColor:
                    tone === 'attention'
                        ? theme.warning
                        : tone === 'danger'
                          ? theme.danger
                          : theme.border,
            },
            style,
        ]}
        testID={testID}
    >
        {children}
    </View>
);

const styles = StyleSheet.create({
    card: { borderRadius: mobileRadius.md, borderWidth: 1, overflow: 'hidden' },
    padded: { gap: mobileSpace.sm, padding: mobileSpace.md },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
