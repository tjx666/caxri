import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';

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
        <Button
            isBusy={isCreating}
            isDisabled={!state.canCreate && !isCreating}
            label={t(isCreating ? 'sessions.new.creating' : 'sessions.new.create')}
            onPress={state.create}
            size="primary"
            testID="new-session-create"
            theme={theme}
            variant="primary"
        />
    );
};
