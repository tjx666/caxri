/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChevronLeft, X } from 'lucide-react-native';

import { mobileSpace, mobileType } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { IconButton } from './icon-button';

/**
 * The header of every pushed screen (Settings, Agent usage, Computer status, Needs you, Archived Sessions, New Session,
 * Add Project). `back` returns to the previous screen; `close` dismisses a screen that slid up as a task (New Session).
 * A screen keeps one of the two for its whole life, so the same corner never means both.
 */
export const ScreenHeader = ({
    leading,
    leadingLabel,
    leadingTestID,
    onLeading,
    subtitle,
    subtitleTestID,
    theme,
    title,
    trailing,
}: {
    leading: 'back' | 'close';
    leadingLabel: string;
    leadingTestID: string;
    onLeading: () => void;
    /**
     * One muted line under the title, such as when the data was last updated.
     */
    subtitle?: string;
    subtitleTestID?: string;
    theme: MobileTheme;
    title: string;
    /**
     * Icon buttons at the trailing edge.
     */
    trailing?: ReactNode;
}) => (
    <View style={styles.header}>
        <IconButton
            accessibilityLabel={leadingLabel}
            icon={leading === 'back' ? ChevronLeft : X}
            onPress={onLeading}
            size={24}
            testID={leadingTestID}
            theme={theme}
        />
        <View style={styles.titles}>
            <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={[mobileType.title, { color: theme.text }]}
            >
                {title}
            </Text>
            {subtitle ? (
                <Text
                    numberOfLines={1}
                    style={[mobileType.caption, { color: theme.muted }]}
                    testID={subtitleTestID}
                >
                    {subtitle}
                </Text>
            ) : null}
        </View>
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
);

const styles = StyleSheet.create({
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        minHeight: 60,
        paddingHorizontal: mobileSpace.xs,
    },
    titles: { flex: 1, gap: mobileSpace.xxs, marginLeft: mobileSpace.xs },
    trailing: { alignItems: 'center', flexDirection: 'row' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
