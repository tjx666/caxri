import type { ReactNode } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native';

import { mobileType } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';

/**
 * The uppercase heading above a group of rows or cards, such as a Session group on the home list or `MEMORY` on
 * Computer status. One size, weight, and tracking everywhere; the caller supplies the uppercase text from i18n.
 */
export const SectionLabel = ({
    children,
    style,
    testID,
    theme,
}: {
    children: ReactNode;
    /**
     * Layout only (padding, flex).
     */
    style?: StyleProp<TextStyle>;
    testID?: string;
    theme: MobileTheme;
}) => (
    <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[mobileType.section, { color: theme.muted }, style]}
        testID={testID}
    >
        {children}
    </Text>
);
