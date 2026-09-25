import { ActivityIndicator, Pressable, Text, View } from 'react-native';

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
    const isEmpty = state.isDashboardLoaded && !state.dashboardError && state.projects.length === 0;
    return (
        <>
            {!state.isDashboardLoaded && !state.dashboardError ? (
                <View style={styles.status}>
                    <ActivityIndicator color={theme.primary} />
                    <Text style={[styles.message, { color: theme.muted }]}>Loading Projects…</Text>
                </View>
            ) : null}
            {state.dashboardError ? (
                <View style={styles.status}>
                    <Text
                        accessibilityRole="alert"
                        style={[styles.message, { color: theme.danger }]}
                    >
                        Unable to load Projects.
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        onPress={state.refreshDashboard}
                        style={styles.secondaryAction}
                        testID="new-session-project-retry"
                    >
                        <Text style={[styles.secondaryText, { color: theme.primary }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : null}
            {isEmpty ? (
                <View style={styles.status} testID="new-session-no-projects">
                    <Text style={[styles.message, { color: theme.text }]}>
                        No Projects available
                    </Text>
                    <Text style={[styles.message, { color: theme.muted }]}>
                        Grant a Project in Caxri on your computer under Settings → Mobile.
                    </Text>
                </View>
            ) : null}
        </>
    );
};
