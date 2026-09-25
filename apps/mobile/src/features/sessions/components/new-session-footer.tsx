import { View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { NewSessionCreateButton } from './new-session-create-button';
import { NewSessionCreateRecovery } from './new-session-create-recovery';
import { NewSessionCreateStatus } from './new-session-create-status';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionFooter = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    if (state.projects.length === 0) return null;
    return (
        <View style={[styles.footer, { borderColor: theme.border }]}>
            <NewSessionCreateStatus state={state} theme={theme} />
            <NewSessionCreateButton state={state} theme={theme} />
            <NewSessionCreateRecovery state={state} theme={theme} />
        </View>
    );
};
