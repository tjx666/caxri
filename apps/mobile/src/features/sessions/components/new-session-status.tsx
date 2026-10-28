import { useRouter } from 'expo-router';

import { ScreenState } from '../../../components/screen-state';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';

export const NewSessionStatus = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const router = useRouter();
    if (state.dashboardError)
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={state.refreshDashboard}
                testID="new-session-projects-error"
                theme={theme}
                title={t('sessions.new.projectsFailed')}
            />
        );
    if (!state.isDashboardLoaded)
        // The Project list only loads while connected; offline, a spinner would never end, so it offers the way out.
        return state.status === 'connected' ? (
            <ScreenState
                kind="loading"
                testID="new-session-projects-pending"
                theme={theme}
                title={t('sessions.new.projectsLoading')}
            />
        ) : (
            <ScreenState
                actionLabel={t('common.close')}
                kind="offline"
                onAction={() => router.back()}
                testID="new-session-projects-pending"
                theme={theme}
                title={t('sessions.new.projectsReconnect')}
            />
        );
    if (state.projects.length === 0)
        return (
            <ScreenState
                detail={t('sessions.new.noProjectsBody')}
                kind="empty"
                testID="new-session-no-projects"
                theme={theme}
                title={t('sessions.new.noProjectsTitle')}
            />
        );
    return null;
};
