import { StyleSheet, Text, View } from 'react-native';

import { MOBILE_AGENT_SUBMIT_MAX_BYTES } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { formatByteSize } from '../../../lib/format-size';
import { mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { ComposerDelivery } from '../session-composer-state';
import { composerDeliveryFeedback } from '../session-composer-state';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * The status lines under the input, set on the `meta` step; the shared composer styles keep only the layout.
 */
const statusStyles = StyleSheet.create({
    reason: { ...mobileType.meta, flex: 1 },
    byteCount: { ...mobileType.caption },
    line: { ...mobileType.meta },
});

/**
 * The lines under the composer row: why sending is off and the byte count near the limit, an image attach failure, and
 * the last delivery's feedback. Split out of `SessionDetailComposer` to keep its control flow flat
 * (react-doctor/no-high-complexity-react-function).
 */
export const SessionComposerStatus = ({
    attachError,
    byteLength,
    delivery,
    disabledReason,
    theme,
}: {
    attachError: string | null | undefined;
    byteLength: number;
    delivery: ComposerDelivery;
    disabledReason: string | null | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const feedback = composerDeliveryFeedback(delivery, t);
    /**
     * The limit only matters near it; showing `0/16384 B` on every idle composer was noise.
     */
    const isShowByteCount = byteLength > MOBILE_AGENT_SUBMIT_MAX_BYTES * 0.75;
    return (
        <>
            {disabledReason || isShowByteCount ? (
                <View style={styles.composerMeta}>
                    <Text style={[statusStyles.reason, { color: theme.muted }]}>
                        {disabledReason ?? ''}
                    </Text>
                    {isShowByteCount ? (
                        <Text style={[statusStyles.byteCount, { color: theme.muted }]}>
                            {formatByteSize(byteLength)}/
                            {formatByteSize(MOBILE_AGENT_SUBMIT_MAX_BYTES)}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {attachError ? (
                <Text
                    accessibilityRole="alert"
                    style={[statusStyles.line, { color: theme.danger }]}
                    testID="session-composer-attach-error"
                >
                    {attachError}
                </Text>
            ) : null}
            {feedback ? (
                <Text
                    accessibilityRole={feedback.isError ? 'alert' : 'text'}
                    style={[
                        statusStyles.line,
                        { color: feedback.isError ? theme.danger : theme.muted },
                    ]}
                    testID="session-composer-feedback"
                >
                    {feedback.message}
                </Text>
            ) : null}
        </>
    );
};
