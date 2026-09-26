/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ChevronLeft, Unlink } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { useMobileClient } from '../connection/mobile-client-provider';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { connectionStatusLabel, DEVICE_ROLE_DETAILS } from './settings-model';

const Section = ({
    children,
    theme,
    title,
}: {
    children: ReactNode;
    theme: MobileTheme;
    title: string;
}) => (
    <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.muted }]}>{title}</Text>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            {children}
        </View>
    </View>
);

const Row = ({
    detail,
    isLast = false,
    label,
    testID,
    theme,
    value,
    valueColor,
}: {
    detail?: string;
    isLast?: boolean;
    label: string;
    testID: string;
    theme: MobileTheme;
    value: string;
    valueColor?: string;
}) => (
    <View
        style={[
            styles.row,
            isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
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
    </View>
);

/**
 * Device-level facts and the one destructive device action. The phone has no appearance settings yet: it follows the
 * Desktop dark theme on purpose.
 */
export const SettingsScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { forgetDevice, status } = useMobileClient();
    const { sessions } = useHostSessions();
    const role = sessions.deviceRole ? DEVICE_ROLE_DETAILS[sessions.deviceRole] : null;
    const confirmForget = (): void => {
        Alert.alert(
            'Forget this computer?',
            `This phone stops connecting to ${sessions.hostDisplayName}. Pair again from Desktop to reconnect.`,
            [
                { style: 'cancel', text: 'Cancel' },
                {
                    onPress: () => {
                        // eslint-disable-next-line no-void -- Forgetting redirects to pairing on success.
                        void forgetDevice();
                    },
                    style: 'destructive',
                    text: 'Forget',
                },
            ],
        );
    };
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="settings-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel="Back"
                    icon={ChevronLeft}
                    onPress={() => router.back()}
                    size={24}
                    testID="settings-back"
                    theme={theme}
                />
                <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
                    Settings
                </Text>
            </View>
            <ScrollView contentContainerStyle={styles.content}>
                <Section theme={theme} title="COMPUTER">
                    <Row
                        label="Name"
                        testID="settings-computer-name"
                        theme={theme}
                        value={sessions.hostDisplayName}
                    />
                    <Row
                        isLast
                        label="Status"
                        testID="settings-connection-status"
                        theme={theme}
                        value={connectionStatusLabel(status)}
                        valueColor={status === 'connected' ? theme.success : theme.muted}
                    />
                </Section>
                <Section theme={theme} title="THIS DEVICE">
                    <Row
                        detail={role?.description}
                        isLast
                        label="Access"
                        testID="settings-access-level"
                        theme={theme}
                        value={role?.label ?? 'Unknown'}
                    />
                </Section>
                <Section theme={theme} title="ABOUT">
                    <Row
                        isLast
                        label="Version"
                        testID="settings-app-version"
                        theme={theme}
                        value={Constants.expoConfig?.version ?? 'Unknown'}
                    />
                </Section>
                <Pressable
                    accessibilityHint="Asks for confirmation before removing this pairing."
                    accessibilityRole="button"
                    onPress={confirmForget}
                    style={({ pressed }) => [
                        styles.forget,
                        {
                            backgroundColor: pressed ? theme.elevated : theme.surface,
                            borderColor: theme.border,
                        },
                    ]}
                    testID="forget-this-computer-action"
                >
                    <Unlink color={theme.danger} size={18} />
                    <Text style={[styles.forgetText, { color: theme.danger }]}>
                        Forget this computer
                    </Text>
                </Pressable>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingHorizontal: 6 },
    heading: { fontSize: 20, fontWeight: '700', marginLeft: 6 },
    content: {
        alignSelf: 'center',
        gap: 22,
        maxWidth: 680,
        paddingBottom: 32,
        paddingHorizontal: 16,
        paddingTop: 8,
        width: '100%',
    },
    section: { gap: 8 },
    sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, paddingHorizontal: 4 },
    card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
    row: {
        gap: 4,
        minHeight: 52,
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    rowMain: { alignItems: 'center', flexDirection: 'row', gap: 12 },
    rowLabel: { flex: 1, fontSize: 15 },
    rowValue: { flexShrink: 1, fontSize: 15, textAlign: 'right' },
    rowDetail: { fontSize: 13, lineHeight: 18 },
    forget: {
        alignItems: 'center',
        borderRadius: 14,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 10,
        justifyContent: 'center',
        minHeight: 52,
    },
    forgetText: { fontSize: 16, fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
