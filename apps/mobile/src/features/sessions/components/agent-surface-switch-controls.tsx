import { Text, View } from 'react-native';

import type { TerminalSurface } from '@caxri/protocol';
import { MessagesSquare, SquareTerminal } from 'lucide-react-native';

import { ConfirmSheet } from '../../../components/confirm-sheet';
import { PopoverAction } from '../../../components/popover-menu';
import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { sessionDetailStyles as styles } from './session-detail-styles';

const surfaceCopy = {
    chat: {
        icon: MessagesSquare,
        open: 'sessions.surface.openAsChat',
        opening: 'sessions.surface.openingAsChat',
    },
    pty: {
        icon: SquareTerminal,
        open: 'sessions.surface.openAsTerminal',
        opening: 'sessions.surface.openingAsTerminal',
    },
} as const;

/**
 * The Session menu's "Open as Chat" / "Open as Terminal" entry, named like Desktop's tab menu entry.
 */
export const AgentSurfaceSwitchMenuAction = ({
    isDisabled,
    onPress,
    target,
    theme,
}: {
    isDisabled: boolean;
    onPress: () => void;
    target: TerminalSurface;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { icon, open } = surfaceCopy[target];
    return (
        <PopoverAction
            disabled={isDisabled}
            icon={icon}
            label={t(open)}
            onPress={onPress}
            testID="session-switch-surface"
            theme={theme}
        />
    );
};

/**
 * Asks before a switch ends the Agent's running turn, with Desktop's words. Stopping a turn only interrupts work, so
 * the confirmation is `primary`, not the red of an action that loses something. Mount it only while `confirmation` is
 * set; dismissing counts as Cancel.
 */
export const AgentSurfaceSwitchConfirm = ({
    confirmation,
    onClose,
    onConfirm,
    theme,
}: {
    confirmation: { provider: string; target: TerminalSurface };
    onClose: () => void;
    onConfirm: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <ConfirmSheet
            confirmLabel={t('sessions.surface.confirmSwitchLabel')}
            detail={t(
                confirmation.target === 'chat'
                    ? 'sessions.surface.confirmSwitchToChat'
                    : 'sessions.surface.confirmSwitchToTerminal',
                { provider: confirmation.provider },
            )}
            onClose={onClose}
            onConfirm={onConfirm}
            testID="session-switch-surface-confirm"
            theme={theme}
            title={t('sessions.surface.turnGuardTitle')}
            tone="primary"
        />
    );
};

/**
 * Below the Session header while a switch is pending or after it failed. The provider restart takes seconds and the
 * menu has already closed, so the pending row shows that the tap registered.
 */
export const AgentSurfaceSwitchStatus = ({
    error,
    pending,
    theme,
}: {
    error: string | null;
    pending: TerminalSurface | null;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (pending)
        return (
            <View
                accessibilityLiveRegion="polite"
                style={styles.surfaceSwitchState}
                testID="session-switch-surface-pending"
            >
                <Spinner color={theme.muted} />
                <Text style={[styles.sendState, { color: theme.muted }]}>
                    {t(surfaceCopy[pending].opening)}
                </Text>
            </View>
        );
    if (!error) return null;
    return (
        <Text
            accessibilityRole="alert"
            style={[styles.sendState, { color: theme.danger }]}
            testID="session-switch-surface-error"
        >
            {error}
        </Text>
    );
};
