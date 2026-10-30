import { Forward, GitFork, Trash2 } from 'lucide-react-native';

import { PopoverAction, PopoverDivider } from '../../../components/popover-menu';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { SessionMenuActions } from '../session-management-model';
import { sessionForkBlocker } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';

/**
 * The Session menu's Fork, Continue in Another Agent, and Delete entries, grouped as Desktop's Session menu keeps Fork
 * with Continue and the removal at the end. Continue and Delete open their step of the Session actions sheet; Fork runs
 * at once. The Fork pair hides for a Session it cannot act on, where the long-press sheet explains why.
 */
export const SessionMenuActionEntries = ({
    actions,
    isConnected,
    onClose,
    session,
    theme,
}: {
    actions: SessionMenuActions;
    isConnected: boolean;
    onClose: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const canFork = sessionForkBlocker(session.primaryTerminal) === undefined;
    const run = (action: 'continue' | 'delete' | 'fork'): void => {
        onClose();
        actions.onAction(action);
    };
    return (
        <>
            <PopoverDivider theme={theme} />
            {canFork ? (
                <>
                    <PopoverAction
                        disabled={!isConnected || actions.isForking}
                        icon={GitFork}
                        label={t('sessions.detail.forkSession')}
                        onPress={() => run('fork')}
                        testID="session-menu-fork"
                        theme={theme}
                    />
                    <PopoverAction
                        disabled={!isConnected}
                        icon={Forward}
                        label={t('sessions.detail.continueInAgent')}
                        onPress={() => run('continue')}
                        testID="session-menu-continue"
                        theme={theme}
                    />
                </>
            ) : null}
            <PopoverAction
                disabled={!isConnected}
                icon={Trash2}
                label={t('sessions.detail.deleteSession')}
                onPress={() => run('delete')}
                testID="session-menu-delete"
                theme={theme}
                tone="danger"
            />
        </>
    );
};
