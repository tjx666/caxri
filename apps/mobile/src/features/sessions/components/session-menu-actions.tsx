import { Text } from 'react-native';

import { Forward, GitFork, Trash2 } from 'lucide-react-native';

import { PopoverAction, PopoverDivider } from '../../../components/popover-menu';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { SessionMenuActions } from '../session-management-model';
import { sessionForkBlocker } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * The Session menu's Fork, Continue in Another Agent, and Delete entries, grouped as Desktop's Session menu keeps Fork
 * with Continue and the removal at the end. Continue and Delete open their step of the Session actions sheet; Fork runs
 * at once. The Fork pair hides for a Session it cannot act on, where the long-press sheet explains why. A device
 * without the control role gets no `actions` and no entries.
 */
export const SessionMenuActionEntries = ({
    actions,
    isConnected,
    onClose,
    session,
    theme,
}: {
    actions: SessionMenuActions | undefined;
    isConnected: boolean;
    onClose: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (!actions) return null;
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

/**
 * The failure of the last Fork, Continue, or Delete started from the Session menu, under the header.
 */
export const SessionMenuActionsError = ({
    actions,
    theme,
}: {
    actions: SessionMenuActions | undefined;
    theme: MobileTheme;
}) =>
    actions?.error ? (
        <Text
            accessibilityRole="alert"
            style={[styles.sendState, { color: theme.danger }]}
            testID="session-menu-error"
        >
            {actions.error}
        </Text>
    ) : null;
