import { View } from 'react-native';

import { CircleAlert, LoaderCircle } from 'lucide-react-native';

import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import { sessionStatusGlyphKind } from '../session-row-model';

/**
 * The single status slot shared by the Session list and the Session header. It mirrors Desktop's
 * `SessionStatusIndicator`: unread attention is amber, running spins, and a settled Session shows nothing so the title
 * carries the row. A failure the user has already read stays marked because nothing else on a phone row reveals it. On
 * a saved copy a running Session shows a still spinner glyph, since the phone cannot know it is still working.
 */
export const SessionStatusGlyph = ({
    isRunShownBelow = false,
    isSaved = false,
    label,
    session,
    theme,
}: {
    /**
     * Whether the screen below the slot already shows the run, so a running Session leaves the slot empty.
     */
    isRunShownBelow?: boolean;
    /**
     * Whether `session` comes from the copy saved on this phone rather than a live read.
     */
    isSaved?: boolean;
    /**
     * The accessible state, `session.stateLabel` unless a saved copy adds its age (see `sessionStateLabel`).
     */
    label?: string;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const stateLabel = label ?? session.stateLabel;
    switch (sessionStatusGlyphKind(session, isSaved, isRunShownBelow)) {
        case 'attention':
            return (
                <View
                    accessibilityLabel={t('sessions.status.needsAttention', { state: stateLabel })}
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
        case 'running':
            return (
                <Spinner
                    accessibilityLabel={stateLabel}
                    color={theme.muted}
                    size={18}
                    testID="session-status-running"
                />
            );
        case 'running-saved':
            return (
                <View
                    accessibilityLabel={stateLabel}
                    accessible
                    testID="session-status-running-saved"
                >
                    <LoaderCircle color={theme.muted} size={18} />
                </View>
            );
        case 'failed':
            return (
                <View accessibilityLabel={stateLabel} accessible testID="session-status-failed">
                    <CircleAlert color={theme.danger} size={18} />
                </View>
            );
        case null:
            return null;
    }
};
