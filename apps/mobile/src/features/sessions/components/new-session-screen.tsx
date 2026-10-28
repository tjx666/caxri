import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { ScreenHeader } from '../../../components/screen-header';
import { useTranslation } from '../../../i18n';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useNewSession } from '../hooks/use-new-session';
import { NewSessionFooter } from './new-session-footer';
import { NewSessionSelections } from './new-session-selections';
import { NewSessionStatus } from './new-session-status';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionScreen = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const theme = useMobileTheme();
    const state = useNewSession();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="new-session-screen"
        >
            <ScreenHeader
                leading="close"
                leadingLabel={t('sessions.backToSessions')}
                leadingTestID="new-session-back"
                onLeading={() => router.back()}
                theme={theme}
                title={t('sessions.new.title')}
            />
            <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
                <NewSessionStatus state={state} theme={theme} />
                <NewSessionSelections
                    onAddProject={
                        state.deviceRole === 'control'
                            ? () =>
                                  router.navigate(
                                      `/h/${encodeURIComponent(state.hostId)}/add-project`,
                                  )
                            : undefined
                    }
                    state={state}
                    theme={theme}
                />
            </ScrollView>
            <NewSessionFooter state={state} theme={theme} />
        </SafeAreaView>
    );
};
