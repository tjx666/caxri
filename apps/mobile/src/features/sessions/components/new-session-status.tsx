import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionStatus = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isEmpty = state.isDashboardLoaded && !state.dashboardError && state.projects.length === 0;
    return (
        <>
            {!state.isDashboardLoaded && !state.dashboardError ? (
                <View style={styles.status} testID="new-session-projects-pending">
                    {/* The Project list only loads while connected; offline, a spinner would never end. */}
                    {state.status === 'connected' ? (
                        <ActivityIndicator color={theme.primary} />
                    ) : null}
                    <Text style={[styles.message, { color: theme.muted }]}>
                        {t(
                            state.status === 'connected'
                                ? 'sessions.new.projectsLoading'
                                : 'sessions.new.projectsReconnect',
                        )}
                    </Text>
                </View>
            ) : null}
            {state.dashboardError ? (
                <View style={styles.status}>
                    <Text
                        accessibilityRole="alert"
                        style={[styles.message, { color: theme.danger }]}
                    >
                        {t('sessions.new.projectsFailed')}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        onPress={state.refreshDashboard}
                        style={styles.secondaryAction}
                        testID="new-session-project-retry"
                    >
                        <Text style={[styles.secondaryText, { color: theme.primary }]}>
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
            {isEmpty ? (
                <View style={styles.status} testID="new-session-no-projects">
                    <Text style={[styles.message, { color: theme.text }]}>
                        {t('sessions.new.noProjectsTitle')}
                    </Text>
                    <Text style={[styles.message, { color: theme.muted }]}>
                        {t('sessions.new.noProjectsBody')}
                    </Text>
                </View>
            ) : null}
        </>
    );
};
