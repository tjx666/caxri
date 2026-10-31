/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChevronRight } from 'lucide-react-native';

import { Card } from '../../components/card';
import { SectionLabel } from '../../components/section-label';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

export const SettingsSection = ({
    children,
    theme,
    title,
}: {
    children: ReactNode;
    theme: MobileTheme;
    title: string;
}) => (
    <View style={styles.section}>
        <SectionLabel style={styles.sectionTitle} theme={theme}>
            {title}
        </SectionLabel>
        <Card padded={false} theme={theme}>
            {children}
        </Card>
    </View>
);

/**
 * One settings fact. With `onPress` the whole row is the button, such as the version row that checks for an update.
 */
export const SettingsRow = ({
    accessibilityHint,
    detail,
    isLast = false,
    label,
    onPress,
    testID,
    theme,
    value,
    valueColor,
}: {
    accessibilityHint?: string;
    detail?: string;
    isLast?: boolean;
    label: string;
    onPress?: () => void;
    testID: string;
    theme: MobileTheme;
    value: string;
    valueColor?: string;
}) => (
    <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityRole={onPress ? 'button' : undefined}
        disabled={!onPress}
        onPress={onPress}
        style={({ pressed }) => [
            styles.row,
            isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <View style={styles.rowMain}>
            <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
            <Text numberOfLines={1} style={[styles.rowValue, { color: valueColor ?? theme.muted }]}>
                {value}
            </Text>
        </View>
        {detail ? <Text style={[styles.rowDetail, { color: theme.muted }]}>{detail}</Text> : null}
    </Pressable>
);

/**
 * A row that leaves the app, such as release notes on GitHub. The chevron marks it as a destination, not a fact.
 */
export const SettingsLinkRow = ({
    accessibilityHint,
    isLast = false,
    label,
    onPress,
    testID,
    theme,
}: {
    accessibilityHint: string;
    isLast?: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityRole="link"
        onPress={onPress}
        style={({ pressed }) => [
            styles.row,
            isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <View style={styles.rowMain}>
            <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
            <ChevronRight color={theme.muted} size={18} />
        </View>
    </Pressable>
);

const styles = StyleSheet.create({
    section: { gap: mobileSpace.sm },
    sectionTitle: { paddingHorizontal: mobileSpace.xs },
    row: {
        gap: mobileSpace.xs,
        minHeight: mobileControl.row,
        justifyContent: 'center',
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.md,
    },
    rowMain: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.md },
    rowLabel: { ...mobileType.body, flex: 1 },
    rowValue: { ...mobileType.body, flexShrink: 1, textAlign: 'right' },
    rowDetail: mobileType.meta,
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
