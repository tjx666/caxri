import { ActivityIndicator, View } from 'react-native';

import { CircleAlert } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';

/**
 * The single status slot shared by the Session list and the Session header. It mirrors Desktop's
 * `SessionStatusIndicator`: unread attention is amber, running spins, and a settled Session shows nothing so the title
 * carries the row. A failure the user has already read stays marked because nothing else on a phone row reveals it.
 */
export const SessionStatusGlyph = ({
    session,
    theme,
}: {
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    if (session.hasUnread)
        return (
            <View
                accessibilityLabel={`Needs attention: ${session.stateLabel}`}
                accessible
                style={{
                    backgroundColor: theme.warning,
                    borderRadius: 5,
                    height: 10,
                    width: 10,
                }}
                testID="session-status-attention"
            />
        );
    if (session.lastActivityState === 'running')
        return (
            <ActivityIndicator
                accessibilityLabel={session.stateLabel}
                color={theme.muted}
                size="small"
                testID="session-status-running"
            />
        );
    if (session.lastActivityState === 'failed')
        return (
            <View accessibilityLabel={session.stateLabel} accessible testID="session-status-failed">
                <CircleAlert color={theme.danger} size={18} />
            </View>
        );
    return null;
};
