import { Pressable, Text, View } from 'react-native';

import type { TerminalSurface } from '@caxri/protocol';
import { MessagesSquare, SquareTerminal } from 'lucide-react-native';

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
    const { icon: Icon, open } = surfaceCopy[target];
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isDisabled }}
            disabled={isDisabled}
            onPress={onPress}
            style={styles.menuAction}
            testID="session-switch-surface"
        >
            <Icon color={theme.muted} size={18} />
            <Text style={[styles.menuActionText, { color: isDisabled ? theme.muted : theme.text }]}>
                {t(open)}
            </Text>
        </Pressable>
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
