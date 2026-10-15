import { Text } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionCreateStatus = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const createError = 'message' in state.createState ? state.createState.message : null;
    return (
        <>
            {state.deviceRole !== 'control' ? (
                <Text style={[styles.message, { color: theme.muted }]}>
                    {t('sessions.new.needsControl')}
                </Text>
            ) : null}
            {state.status !== 'connected' ? (
                <Text style={[styles.message, { color: theme.muted }]}>
                    {t('sessions.new.createOffline')}
                </Text>
            ) : null}
            {createError ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.message, { color: theme.danger }]}
                    testID="new-session-create-error"
                >
                    {state.createState.kind === 'partial'
                        ? t('sessions.new.partial', { error: createError })
                        : createError}
                </Text>
            ) : null}
        </>
    );
};
