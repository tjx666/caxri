/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';
import { Unlink } from 'lucide-react-native';

import { Button } from '../../components/button';
import { ConfirmSheet } from '../../components/confirm-sheet';
import { ScreenHeader } from '../../components/screen-header';
import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { useMobileClient } from '../connection/mobile-client-provider';
import { useConfirmForgetComputer } from '../connection/use-confirm-forget-computer';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { SettingsAboutSection } from './settings-about-section';
import { connectionStatusLabel, deviceRoleDetails } from './settings-model';
import { SettingsRow, SettingsSection } from './settings-rows';

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
                <SettingsSection theme={theme} title={t('settings.section.computer')}>
                    <SettingsRow
                        label={t('settings.name')}
                        testID="settings-computer-name"
                        theme={theme}
                        value={sessions.hostDisplayName}
                    />
                    <SettingsRow
                        isLast
                        label={t('settings.status')}
                        testID="settings-connection-status"
                        theme={theme}
                        value={connectionStatusLabel(status, t)}
                        valueColor={status === 'connected' ? theme.success : theme.muted}
                    />
                </SettingsSection>
                <SettingsSection theme={theme} title={t('settings.section.thisDevice')}>
                    <SettingsRow
                        detail={role?.description}
                        isLast
                        label={t('settings.access')}
                        testID="settings-access-level"
                        theme={theme}
                        value={role?.label ?? t('settings.unknown')}
                    />
                </SettingsSection>
                <SettingsAboutSection theme={theme} />
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
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
