import { View } from 'react-native';

import { CircleAlert, CircleQuestionMark, Clock, LoaderCircle } from 'lucide-react-native';

import { BackgroundRing } from '../../../components/background-ring';
import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import { sessionStatusGlyphKind } from '../session-row-model';

/**
 * The single status slot shared by the Session list and the Session header. It mirrors Desktop's
 * `SessionStatusIndicator`: unread attention is amber (a question mark when the Agent waits on the user, a ringed dot
 * for a result, so the cause does not rest on color), running spins (a slow dotted ring while the Agent only waits on
 * its own background work), and a settled Session shows nothing so the title carries the row. A failure the user has
 * already read stays marked because nothing else on a phone row reveals it. On a saved copy a running Session shows a
 * still spinner glyph, since the phone cannot know it is still working.
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
        case 'attention-waiting':
            return (
                <View
                    accessibilityLabel={t('sessions.status.waitingForAnswer', {
                        state: stateLabel,
                    })}
                    accessible
                    testID="session-status-attention-waiting"
                >
                    <CircleQuestionMark color={theme.warning} size={18} strokeWidth={2.25} />
                </View>
            );
        case 'attention-result':
            return (
                <View
                    accessibilityLabel={t('sessions.status.needsAttention', { state: stateLabel })}
                    accessible
                    style={{
                        alignItems: 'center',
                        borderColor: theme.warning,
                        borderRadius: 9,
                        borderWidth: 1.5,
                        height: 18,
                        justifyContent: 'center',
                        width: 18,
                    }}
                    testID="session-status-attention"
                >
                    <View
                        style={{
                            backgroundColor: theme.warning,
                            borderRadius: 4,
                            height: 8,
                            width: 8,
                        }}
                    />
                </View>
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
        case 'running-background':
            return (
                <BackgroundRing
                    accessibilityLabel={stateLabel}
                    color={theme.muted}
                    size={18}
                    testID="session-status-running-background"
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
        case 'usage-wait':
            return (
                <View accessibilityLabel={stateLabel} accessible testID="session-status-usage-wait">
                    <Clock color={theme.muted} size={18} />
                </View>
            );
        case null:
            return null;
    }
};
