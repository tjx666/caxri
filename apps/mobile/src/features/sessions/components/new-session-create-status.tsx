import { Text } from 'react-native';

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
    const createError = 'message' in state.createState ? state.createState.message : null;
    return (
        <>
            {state.deviceRole !== 'control' ? (
                <Text style={[styles.message, { color: theme.muted }]}>
                    This device needs control access to create Sessions.
                </Text>
            ) : null}
            {state.status !== 'connected' ? (
                <Text style={[styles.message, { color: theme.muted }]}>
                    Reconnect to Caxri before creating a Session.
                </Text>
            ) : null}
            {createError ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.message, { color: theme.danger }]}
                    testID="new-session-create-error"
                >
                    {state.createState.kind === 'partial'
                        ? `Session created, but the Agent did not start: ${createError}`
                        : createError}
                </Text>
            ) : null}
        </>
    );
};
