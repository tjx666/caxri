import { ActivityIndicator, Pressable, Text } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionCreateButton = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isCreating = state.createState.kind === 'creating';
    return (
        <Pressable
            accessibilityLabel={t('sessions.new.create')}
            accessibilityRole="button"
            accessibilityState={{ disabled: !state.canCreate, busy: isCreating }}
            disabled={!state.canCreate}
            onPress={state.create}
            style={[
                styles.action,
                { backgroundColor: state.canCreate ? theme.primary : theme.surface },
            ]}
            testID="new-session-create"
        >
            {isCreating ? <ActivityIndicator color={theme.primaryForeground} /> : null}
            <Text
                style={[
                    styles.actionText,
                    { color: state.canCreate ? theme.primaryForeground : theme.muted },
                ]}
            >
                {t(isCreating ? 'sessions.new.creating' : 'sessions.new.create')}
            </Text>
        </Pressable>
    );
};
