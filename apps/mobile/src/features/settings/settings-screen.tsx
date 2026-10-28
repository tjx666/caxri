/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Unlink } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Card } from '../../components/card';
import { ConfirmSheet } from '../../components/confirm-sheet';
import { ScreenHeader } from '../../components/screen-header';
import { SectionLabel } from '../../components/section-label';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { useMobileClient } from '../connection/mobile-client-provider';
import { useConfirmForgetComputer } from '../connection/use-confirm-forget-computer';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { MobileUpdateSettingsRow } from '../update/mobile-update-settings-row';
import { useMobileUpdate } from '../update/use-mobile-update';
import { connectionStatusLabel, deviceRoleDetails } from './settings-model';

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
        <SectionLabel style={styles.sectionTitle} theme={theme}>
            {title}
        </SectionLabel>
        <Card padded={false} theme={theme}>
            {children}
        </Card>
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
    const { t } = useTranslation();
    const { status } = useMobileClient();
    const { sessions } = useHostSessions();
    const mobileUpdate = useMobileUpdate();
    const { update } = mobileUpdate;
    const role = sessions.deviceRole ? deviceRoleDetails(sessions.deviceRole, t) : null;
    const forget = useConfirmForgetComputer();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="settings-screen"
        >
            <ScreenHeader
                leading="back"
                leadingLabel={t('settings.back')}
                leadingTestID="settings-back"
                onLeading={() => router.back()}
                theme={theme}
                title={t('settings.title')}
            />
            <ScrollView contentContainerStyle={styles.content}>
                <Section theme={theme} title={t('settings.section.computer')}>
                    <Row
                        label={t('settings.name')}
                        testID="settings-computer-name"
                        theme={theme}
                        value={sessions.hostDisplayName}
                    />
                    <Row
                        isLast
                        label={t('settings.status')}
                        testID="settings-connection-status"
                        theme={theme}
                        value={connectionStatusLabel(status, t)}
                        valueColor={status === 'connected' ? theme.success : theme.muted}
                    />
                </Section>
                <Section theme={theme} title={t('settings.section.thisDevice')}>
                    <Row
                        detail={role?.description}
                        isLast
                        label={t('settings.access')}
                        testID="settings-access-level"
                        theme={theme}
                        value={role?.label ?? t('settings.unknown')}
                    />
                </Section>
                <Section theme={theme} title={t('settings.section.about')}>
                    <Row
                        isLast={!update}
                        label={t('settings.version')}
                        testID="settings-app-version"
                        theme={theme}
                        value={Constants.expoConfig?.version ?? t('settings.unknown')}
                    />
                    {update ? (
                        <MobileUpdateSettingsRow
                            mobileUpdate={{ ...mobileUpdate, update }}
                            theme={theme}
                        />
                    ) : null}
                </Section>
                <Button
                    accessibilityHint={t('settings.forgetComputerHint')}
                    icon={Unlink}
                    label={t('settings.forgetComputer')}
                    onPress={forget.open}
                    testID="forget-this-computer-action"
                    theme={theme}
                    variant="danger"
                />
            </ScrollView>
            {forget.isOpen ? (
                <ConfirmSheet
                    confirmLabel={t('connection.forget.confirm')}
                    detail={t('connection.forget.message', { host: sessions.hostDisplayName })}
                    onClose={forget.close}
                    onConfirm={forget.confirm}
                    testID="forget-computer-sheet"
                    theme={theme}
                    title={t('connection.forget.title')}
                    tone="danger"
                />
            ) : null}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    content: {
        alignSelf: 'center',
        gap: mobileSpace.xl,
        maxWidth: 680,
        paddingBottom: mobileSpace.xxl,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.sm,
        width: '100%',
    },
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
