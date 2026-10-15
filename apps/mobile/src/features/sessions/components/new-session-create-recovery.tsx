import { Pressable, Text } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionCreateRecovery = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const createdSessionId =
        state.createState.kind === 'partial' ? state.createState.sessionId : null;
    return (
        <>
            {createdSessionId ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => state.openCreatedSession(createdSessionId, false)}
                    style={styles.secondaryAction}
                    testID="new-session-open-created"
                >
                    <Text style={[styles.secondaryText, { color: theme.primary }]}>
                        {t('sessions.new.openCreated')}
                    </Text>
                </Pressable>
            ) : null}
            {state.createState.kind === 'uncertain' ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={state.checkSessions}
                    style={styles.secondaryAction}
                    testID="new-session-check-sessions"
                >
                    <Text style={[styles.secondaryText, { color: theme.primary }]}>
                        {t('sessions.new.checkSessions')}
                    </Text>
                </Pressable>
            ) : null}
            {state.createState.kind === 'uncertain' && state.createState.checkedSessions ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={state.acknowledgeCheckedCreate}
                    style={styles.secondaryAction}
                    testID="new-session-checked-try-again"
                >
                    <Text style={[styles.secondaryText, { color: theme.primary }]}>
                        {t('sessions.new.checkedTryAgain')}
                    </Text>
                </Pressable>
            ) : null}
        </>
    );
};
