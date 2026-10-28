import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';

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
                <Button
                    label={t('sessions.new.openCreated')}
                    onPress={() => state.openCreatedSession(createdSessionId, false)}
                    testID="new-session-open-created"
                    theme={theme}
                    variant="outline"
                />
            ) : null}
            {state.createState.kind === 'uncertain' ? (
                <Button
                    label={t('sessions.new.checkSessions')}
                    onPress={state.checkSessions}
                    testID="new-session-check-sessions"
                    theme={theme}
                    variant="outline"
                />
            ) : null}
            {state.createState.kind === 'uncertain' && state.createState.checkedSessions ? (
                <Button
                    label={t('sessions.new.checkedTryAgain')}
                    onPress={state.acknowledgeCheckedCreate}
                    testID="new-session-checked-try-again"
                    theme={theme}
                    variant="outline"
                />
            ) : null}
        </>
    );
};
